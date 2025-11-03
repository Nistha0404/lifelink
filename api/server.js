const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: { rejectUnauthorized: false },
});

const FAST2SMS_API_KEY = process.env.FAST2SMS_API_KEY;
const OPENCAGE_API_KEY = process.env.OPENCAGE_API_KEY;
const otpStore = {};

// HELPER FUNCTIONS
function calculateDistance(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return Infinity;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function generate4DigitToken() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function generateQRToken() {
  return 'QR' + Math.random().toString(36).substr(2, 10).toUpperCase();
}

async function generateUniquePatientToken(client) {
  for (let i = 0; i < 10; i++) {
    const token = generate4DigitToken();
    const { rows } = await client.query("SELECT 1 FROM blood_requests WHERE patient_token = $1 AND status IN ('pending','accepted')", [token]);
    if (rows.length === 0) return token;
  }
  return generate4DigitToken();
}

async function generateUniqueDonorToken(client) {
  for (let i = 0; i < 10; i++) {
    const token = generate4DigitToken();
    const { rows } = await client.query('SELECT 1 FROM donation_commitments WHERE donor_token = $1', [token]);
    if (rows.length === 0) return token;
  }
  throw new Error('Could not generate unique donor token.');
}

// ESCALATION
async function checkAndEscalate(requestId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reqRes = await client.query("SELECT status, blood_type_needed FROM blood_requests WHERE request_id = $1 FOR UPDATE", [requestId]);
    if (!reqRes.rows.length || reqRes.rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return;
    }
    const sentAlerts = await client.query("SELECT 1 FROM alert_status WHERE request_id = $1 AND status = 'sent'", [requestId]);
    if (sentAlerts.rows.length === 0) {
      console.log(`Escalating request ${requestId} to donors...`);
      await client.query("UPDATE blood_requests SET status = 'escalated' WHERE request_id = $1", [requestId]);
      const { rows: donors } = await client.query("SELECT user_id, phone_number, full_name FROM users WHERE role = 'donor' AND blood_type = $1", [reqRes.rows[0].blood_type_needed]);
      console.log(`Notified ${donors.length} donors for request ${requestId}`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`Error in checkAndEscalate: ${e.message}`);
  } finally {
    client.release();
  }
}

// PATIENT AUTH
app.post('/api/server/send-otp', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ success: false, message: 'Phone number required.' });
  try {
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    otpStore[phoneNumber] = { otp, expiry: Date.now() + 300000 };
    console.log(`Patient OTP for ${phoneNumber}: ${otp}`);
    res.json({ success: true, otp, message: 'OTP generated.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/server/patient-login', async (req, res) => {
  const { phoneNumber, fullName, pincode, otp } = req.body;
  const record = otpStore[phoneNumber];
  if (!record || record.otp !== otp || Date.now() >= record.expiry) {
    return res.status(401).json({ success: false, message: 'Invalid or expired OTP.' });
  }
  delete otpStore[phoneNumber];
  try {
    const existing = await pool.query("SELECT * FROM users WHERE phone_number = $1 AND role = 'patient'", [phoneNumber]);
    if (existing.rows.length) {
      const { rows } = await pool.query("UPDATE users SET full_name = $1, pincode = $2, last_login = NOW() WHERE phone_number = $3 AND role = 'patient' RETURNING *", [fullName, pincode, phoneNumber]);
      return res.json({ success: true, message: 'Login successful!', user: rows[0] });
    }
    if (!fullName || !pincode) {
      return res.status(400).json({ success: false, message: 'Name and pincode required for registration.' });
    }
    const { rows } = await pool.query("INSERT INTO users (full_name, phone_number, role, pincode) VALUES ($1, $2, 'patient', $3) RETURNING *", [fullName, phoneNumber, pincode]);
    res.status(201).json({ success: true, message: 'Registration successful!', user: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Database error.' });
  }
});

// PATIENT SOS
app.post('/api/server/request-blood', async (req, res) => {
  const { patientId, bloodType, pincode, latitude, longitude } = req.body;
  console.log('Received SOS Request:', { patientId, bloodType, pincode, latitude, longitude });
  if (!patientId || !bloodType) return res.status(400).json({ success: false, message: 'Missing required fields.' });
  if (!latitude || !longitude) return res.status(400).json({ success: false, message: 'Precise location is required.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const patientToken = await generateUniquePatientToken(client);
    const deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const { rows } = await client.query(`INSERT INTO blood_requests (patient_id, blood_type_needed, pincode, latitude, longitude, status, patient_token, deadline) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7) RETURNING request_id, patient_token`, [patientId, bloodType, pincode, latitude, longitude, patientToken, deadline]);
    const requestId = rows[0].request_id;
    const { rows: hospitals } = await client.query('SELECT hospital_id, hospital_name, latitude, longitude FROM hospitals WHERE latitude IS NOT NULL AND longitude IS NOT NULL');
    const alertPromises = [];
    let hospitalsNotified = 0;
    for (const hospital of hospitals) {
      const distance = calculateDistance(latitude, longitude, hospital.latitude, hospital.longitude);
      if (distance <= 10) {
        hospitalsNotified++;
        alertPromises.push(client.query('INSERT INTO alert_status (request_id, hospital_id, distance_km, status) VALUES ($1, $2, $3, $4)', [requestId, hospital.hospital_id, distance.toFixed(2), 'sent']));
      }
    }
    await Promise.all(alertPromises);
    await client.query('COMMIT');
    setTimeout(() => { checkAndEscalate(requestId); }, 10 * 60 * 1000 + 1000);
    res.status(201).json({ success: true, message: `SOS Alert sent to ${hospitalsNotified} nearby hospitals!`, requestId, patient_token: rows[0].patient_token });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error in request-blood:', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  } finally {
    client.release();
  }
});

app.get('/api/server/request-status/:requestId', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT br.status, br.patient_token, h.hospital_name, h.pincode, h.address FROM blood_requests br LEFT JOIN hospitals h ON h.hospital_id = br.accepted_by_hospital_id WHERE br.request_id = $1`, [req.params.requestId]);
    if (rows.length === 0) return res.status(404).json({ status: 'not_found' });
    const request = rows[0];
    if (request.status === 'accepted') {
      res.json({ status: 'accepted', hospital: { name: request.hospital_name, pincode: request.pincode, address: request.address }, patient_token: request.patient_token });
    } else if (request.status === 'escalated') {
      res.json({ status: 'escalated', patient_token: request.patient_token });
    } else {
      res.json({ status: 'pending', patient_token: request.patient_token });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ status: 'error', message: 'Server error.' });
  }
});

app.get('/api/server/requests/history/:patientId', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT br.request_id, br.blood_type_needed, br.pincode, br.status, br.created_at, br.patient_token, h.hospital_name FROM blood_requests br LEFT JOIN hospitals h ON h.hospital_id = br.accepted_by_hospital_id WHERE br.patient_id = $1 ORDER BY br.created_at DESC`, [req.params.patientId]);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json([]);
  }
});

// HOSPITAL AUTH
app.post('/api/server/hospital-register', async (req, res) => {
  const { hospitalName, address, pincode, phoneNumber, password } = req.body;
  if (!hospitalName || !pincode || !phoneNumber || !password || !address) return res.status(400).json({ success: false, message: 'All fields required.' });
  let latitude = null, longitude = null;
  try {
    const geoResponse = await axios.get('https://api.opencagedata.com/geocode/v1/json', { params: { q: `${address}, ${pincode}`, key: OPENCAGE_API_KEY, limit: 1, countrycode: 'in' } });
    if (geoResponse.data && geoResponse.data.results.length > 0) {
      const { lat, lng } = geoResponse.data.results[0].geometry;
      latitude = lat;
      longitude = lng;
    } else {
      throw new Error('Could not geocode address.');
    }
  } catch (geoError) {
    console.error("Geocoding Error:", geoError.message);
    return res.status(400).json({ success: false, message: 'Could not validate address.' });
  }
  try {
    const existing = await pool.query('SELECT 1 FROM hospitals WHERE phone_number = $1', [phoneNumber]);
    if (existing.rows.length) return res.status(409).json({ success: false, message: 'Phone already registered.' });
    const last = await pool.query('SELECT hospital_id FROM hospitals ORDER BY hospital_id DESC LIMIT 1');
    const nextNum = last.rows.length ? parseInt(last.rows[0].hospital_id.replace('HOS','')) + 1 : 101;
    const newId = `HOS${nextNum}`;
    const { rows } = await pool.query(`INSERT INTO hospitals (hospital_id, hospital_name, address, pincode, phone_number, password_hash, blood_inventory, latitude, longitude) VALUES ($1, $2, $3, $4, $5, $6, '{}', $7, $8) RETURNING hospital_id`, [newId, hospitalName, address, pincode, phoneNumber, password, latitude, longitude]);
    res.status(201).json({ success: true, hospitalId: rows[0].hospital_id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/server/hospital-login', async (req, res) => {
  const { hospitalId, password } = req.body;
  if (!hospitalId || !password) return res.status(400).json({ success: false, message: 'Hospital ID and password required.' });
  try {
    const { rows } = await pool.query('SELECT * FROM hospitals WHERE hospital_id = $1', [hospitalId.toUpperCase()]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Hospital not found.' });
    const hospital = rows[0];
    if (password !== hospital.password_hash) return res.status(401).json({ success: false, message: 'Invalid password.' });
    const { password_hash, ...safeHospital } = hospital;
    res.json({ success: true, hospital: safeHospital });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// HOSPITAL ONE-CLICK SOS (Component-Specific)
app.post('/api/hospital/sos-component', async (req, res) => {
  const { hospitalId, component, bloodType, units, urgency, latitude, longitude, pincode } = req.body;
  if (!hospitalId || !component || !units || !urgency) return res.status(400).json({ success: false, message: 'Missing fields.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const { rows } = await client.query(`INSERT INTO blood_requests (creator_hospital_id, component_needed, blood_type_needed, units_needed, urgency, latitude, longitude, pincode, status, deadline, is_hospital_initiated, verification_status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, TRUE, 'verified') RETURNING request_id`, [hospitalId, component, bloodType || 'Any', units, urgency, latitude, longitude, pincode, deadline]);
    const requestId = rows[0].request_id;
    const { rows: hospitals } = await client.query('SELECT hospital_id, latitude, longitude FROM hospitals WHERE hospital_id != $1 AND latitude IS NOT NULL', [hospitalId]);
    let notified = 0;
    for (const h of hospitals) {
      const dist = calculateDistance(latitude, longitude, h.latitude, h.longitude);
      if (dist <= 15) {
        await client.query('INSERT INTO alert_status (request_id, hospital_id, distance_km, status) VALUES ($1, $2, $3, $4)', [requestId, h.hospital_id, dist.toFixed(2), 'sent']);
        notified++;
      }
    }
    await client.query('COMMIT');
    res.status(201).json({ success: true, message: `SOS sent to ${notified} hospitals`, requestId });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  } finally {
    client.release();
  }
});

// HOSPITAL STOCK UPDATE (With Confidence)
app.post('/api/hospital/stock-update', async (req, res) => {
  const { hospitalId, bloodType, component, unitsChange, confidence, notes } = req.body;
  if (!hospitalId || !bloodType || !component) return res.status(400).json({ success: false, message: 'Missing fields.' });
  try {
    const { rows: current } = await pool.query('SELECT blood_inventory FROM hospitals WHERE hospital_id = $1', [hospitalId]);
    const inventory = current[0]?.blood_inventory || {};
    const key = `${bloodType}_${component}`;
    const unitsBefore = inventory[key] || 0;
    const unitsAfter = unitsBefore + (unitsChange || 0);
    inventory[key] = Math.max(0, unitsAfter);
    await pool.query('UPDATE hospitals SET blood_inventory = $1 WHERE hospital_id = $2', [JSON.stringify(inventory), hospitalId]);
    await pool.query('INSERT INTO hospital_stock_log (hospital_id, blood_type, component, units_before, units_after, change_amount, confidence_level, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [hospitalId, bloodType, component, unitsBefore, unitsAfter, unitsChange, confidence || 'medium', notes]);
    res.json({ success: true, message: 'Stock updated', newTotal: unitsAfter });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// HOSPITAL CHECK-IN SCANNER
app.post('/api/hospital/scan-checkin', async (req, res) => {
  const { qrToken, hospitalId } = req.body;
  if (!qrToken) return res.status(400).json({ success: false, message: 'QR token required.' });
  try {
    const { rows } = await pool.query('SELECT * FROM donor_checkins WHERE qr_token = $1', [qrToken]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Invalid QR token.' });
    const checkin = rows[0];
    if (checkin.status === 'arrived') return res.json({ success: true, message: 'Already checked in', checkin });
    await pool.query("UPDATE donor_checkins SET status = 'arrived', checkin_time = NOW(), scanned_by = $1 WHERE checkin_id = $2", [hospitalId, checkin.checkin_id]);
    await pool.query('UPDATE donor_reliability SET successful_checkins = successful_checkins + 1, total_commitments = total_commitments + 1 WHERE donor_id = $1', [checkin.donor_id]);
    res.json({ success: true, message: 'Check-in successful', checkin });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// HOSPITAL PLAYBOOKS
app.get('/api/hospital/playbooks/:hospitalId', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM playbooks WHERE hospital_id = $1 AND is_active = TRUE ORDER BY priority DESC, updated_at DESC", [req.params.hospitalId]);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.json([]);
  }
});

app.post('/api/hospital/playbooks', async (req, res) => {
  const { hospitalId, title, content, category, priority } = req.body;
  try {
    const { rows } = await pool.query("INSERT INTO playbooks (hospital_id, title, content, category, priority) VALUES ($1, $2, $3, $4, $5) RETURNING *", [hospitalId, title, content, category, priority || 1]);
    res.status(201).json({ success: true, playbook: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Failed to save playbook.' });
  }
});

// HOSPITAL REPORTS
app.get('/api/hospital/reports/:hospitalId', async (req, res) => {
  try {
    const { rows: summary } = await pool.query(`SELECT status, COUNT(*) as count FROM blood_requests WHERE creator_hospital_id = $1 GROUP BY status`, [req.params.hospitalId]);
    const { rows: avgResponse } = await pool.query(`SELECT AVG(response_time_seconds) as avg_time FROM request_audit WHERE hospital_id = $1 AND action = 'accepted'`, [req.params.hospitalId]);
    res.json({ summary, avgResponseTime: avgResponse[0]?.avg_time || 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Failed to generate report.' });
  }
});

// HOSPITAL DONOR APPOINTMENTS
app.get('/api/hospital/appointments/:hospitalId', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT dc.commitment_id, dc.status, dc.created_at, u.full_name, u.blood_type, u.phone_number, ch.qr_token FROM donation_commitments dc JOIN users u ON dc.donor_id = u.user_id LEFT JOIN donor_checkins ch ON ch.commitment_id = dc.commitment_id WHERE dc.hospital_id = $1 AND dc.status IN ('scheduled', 'committed') ORDER BY dc.created_at DESC`, [req.params.hospitalId]);
    res.json({ success: true, appointments: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// HOSPITAL SOS MONITOR
app.get('/api/server/sos-alerts/:hospitalId', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT br.request_id, br.blood_type_needed, br.patient_token, br.deadline, u.full_name AS patient_name, als.distance_km FROM alert_status als JOIN blood_requests br ON als.request_id = br.request_id JOIN users u ON br.patient_id = u.user_id WHERE als.hospital_id = $1 AND als.status = 'sent' AND br.status = 'pending' ORDER BY als.created_at DESC`, [req.params.hospitalId.toUpperCase()]);
    const alerts = rows.map(req => ({ requestId: req.request_id, patientName: req.patient_name, bloodType: req.blood_type_needed, patientToken: req.patient_token, distance: parseFloat(req.distance_km), deadline: req.deadline }));
    res.json(alerts);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error.' });
  }
});

app.post('/api/server/hospital-response', async (req, res) => {
  const { requestId, hospitalId, response } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reqRes = await client.query("SELECT status FROM blood_requests WHERE request_id = $1 FOR UPDATE", [requestId]);
    if (!reqRes.rows.length || reqRes.rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Request no longer active.' });
    }
    if (response === 'accept') {
      await client.query("UPDATE alert_status SET status = 'accepted', response_at = NOW() WHERE request_id = $1 AND hospital_id = $2", [requestId, hospitalId]);
      await client.query("UPDATE alert_status SET status = 'closed', response_at = NOW() WHERE request_id = $1 AND hospital_id != $2 AND status = 'sent'", [requestId, hospitalId]);
      await client.query("UPDATE blood_requests SET status = 'accepted', accepted_by_hospital_id = $1 WHERE request_id = $2", [hospitalId, requestId]);
    } else {
      await client.query("UPDATE alert_status SET status = 'rejected', response_at = NOW() WHERE request_id = $1 AND hospital_id = $2", [requestId, hospitalId]);
    }
    await client.query('COMMIT');
    if (response === 'reject') checkAndEscalate(requestId);
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  } finally {
    client.release();
  }
});

app.post('/api/server/verify-token', async (req, res) => {
  const { token } = req.body;
  if (!token || token.length !== 4) return res.status(400).json({ success: false, message: '4-digit token required.' });
  try {
    const { rows: p } = await pool.query(`SELECT br.request_id, br.patient_id, br.patient_token, br.blood_type_needed, br.pincode, u.full_name AS patient_name FROM blood_requests br JOIN users u ON u.user_id = br.patient_id WHERE br.patient_token = $1 LIMIT 1`, [token]);
    if (p.length) return res.json({ success: true, type: 'patient', request_id: p[0].request_id, patient_token: p[0].patient_token, patient: { user_id: p[0].patient_id, full_name: p[0].patient_name, blood_type_needed: p[0].blood_type_needed, pincode: p[0].pincode } });
    const { rows: d } = await pool.query(`SELECT dc.commitment_id, dc.request_id, dc.donor_id, dc.donor_token, dc.status AS commitment_status, du.full_name AS donor_name, du.blood_type AS donor_blood_type, br.patient_token FROM donation_commitments dc JOIN users du ON du.user_id = dc.donor_id JOIN blood_requests br ON br.request_id = dc.request_id WHERE dc.donor_token = $1 LIMIT 1`, [token]);
    if (d.length) return res.json({ success: true, type: 'donor', donor_token: d[0].donor_token, donor: { user_id: d[0].donor_id, full_name: d[0].donor_name, blood_type: d[0].donor_blood_type }, matched_patient_token: d[0].patient_token, request_id: d[0].request_id });
    res.status(404).json({ success: false, message: 'Token not found.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// DONOR AUTH
app.post('/api/server/donor/generate-otp', async (req, res) => {
  const { phoneNumber } = req.body;
  try {
    const { rows } = await pool.query("SELECT user_id FROM users WHERE phone_number = $1 AND role = 'donor'", [phoneNumber]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Not a registered donor.' });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[phoneNumber] = { otp, expiry: Date.now() + 300000 };
    console.log(`Donor OTP for ${phoneNumber}: ${otp}`);
    res.json({ success: true, otp, message: 'OTP generated.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/server/donor/login', async (req, res) => {
  const { phoneNumber, otp } = req.body;
  const record = otpStore[phoneNumber];
  if (!record || record.otp !== otp || Date.now() >= record.expiry) return res.status(401).json({ success: false, message: 'Invalid or expired OTP.' });
  try {
    delete otpStore[phoneNumber];
    const { rows } = await pool.query("SELECT user_id, full_name, phone_number, pincode, blood_type, role FROM users WHERE phone_number = $1 AND role = 'donor'", [phoneNumber]);
    res.json({ success: true, message: 'Login successful!', user: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/server/donor/register-request', async (req, res) => {
  const { phoneNumber } = req.body;
  try {
    const existing = await pool.query('SELECT 1 FROM users WHERE phone_number = $1', [phoneNumber]);
    if (existing.rows.length) return res.status(409).json({ success: false, message: 'Phone already registered.' });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[phoneNumber] = { otp, expiry: Date.now() + 300000 };
    console.log(`Donor registration OTP for ${phoneNumber}: ${otp}`);
    res.json({ success: true, otp, message: 'OTP sent.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/server/donor/register-confirm', async (req, res) => {
  const { fullName, phoneNumber, pincode, bloodType, otp } = req.body;
  const record = otpStore[phoneNumber];
  if (!record || record.otp !== otp || Date.now() >= record.expiry) return res.status(400).json({ success: false, message: 'Invalid or expired OTP.' });
  try {
    const { rows } = await pool.query("INSERT INTO users (full_name, phone_number, pincode, blood_type, role) VALUES ($1, $2, $3, $4, 'donor') RETURNING user_id", [fullName, phoneNumber, pincode, bloodType.toUpperCase()]);
    await pool.query("INSERT INTO donor_reliability (donor_id) VALUES ($1)", [rows[0].user_id]);
    delete otpStore[phoneNumber];
    res.status(201).json({ success: true, message: 'Registration successful!' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// DONOR ELIGIBILITY CHECK
app.post('/api/donor/eligibility-check', async (req, res) => {
  const { donorId, isAbove18, hasRecentInfection, hasRecentTattoo, consumedAlcohol24h, onMedication, medicationDetails } = req.body;
  if (!donorId) return res.status(400).json({ success: false, message: 'Donor ID required.' });
  try {
    const isEligible = isAbove18 && !hasRecentInfection && !hasRecentTattoo && !consumedAlcohol24h;
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const { rows } = await pool.query(`INSERT INTO donor_eligibility (donor_id, is_above_18, has_recent_infection, has_recent_tattoo, consumed_alcohol_24h, on_medication, medication_details, is_eligible, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`, [donorId, isAbove18, hasRecentInfection, hasRecentTattoo, consumedAlcohol24h, onMedication, medicationDetails, isEligible, expiresAt]);
    res.json({ success: true, eligible: isEligible, eligibility: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// DONOR TWO-TAP CONFIRMATION
app.post('/api/donor/confirm-sos', async (req, res) => {
  const { requestId, donorId, latitude, longitude, confirmationStep } = req.body;
  if (!requestId || !donorId) return res.status(400).json({ success: false, message: 'Missing fields.' });
  if (confirmationStep === 1) {
    return res.json({ success: true, message: 'First confirmation received. Please confirm again.' });
  }
  if (confirmationStep === 2) {
    if (!latitude || !longitude) return res.status(400).json({ success: false, message: 'Location required for final confirmation.' });
    try {
      const { rows: request } = await pool.query('SELECT latitude, longitude, blood_type_needed FROM blood_requests WHERE request_id = $1', [requestId]);
      if (!request.length) return res.status(404).json({ success: false, message: 'Request not found.' });
      const patientLat = request[0].latitude;
      const patientLon = request[0].longitude;
      const distance = calculateDistance(latitude, longitude, patientLat, patientLon);
      if (distance > 15) {
        return res.json({ success: false, message: `You are ${distance.toFixed(1)} km away. Must be within 15 km.`, distance });
      }
      const { rows: hospitals } = await pool.query('SELECT hospital_id, hospital_name, latitude, longitude, address, pincode FROM hospitals WHERE latitude IS NOT NULL');
      let bestHospital = null;
      let minMaxDist = Infinity;
      for (const h of hospitals) {
        const donorToHospital = calculateDistance(latitude, longitude, h.latitude, h.longitude);
        const patientToHospital = calculateDistance(patientLat, patientLon, h.latitude, h.longitude);
        const maxDist = Math.max(donorToHospital, patientToHospital);
        if (maxDist < minMaxDist) {
          minMaxDist = maxDist;
          bestHospital = { ...h, donorDist: donorToHospital, patientDist: patientToHospital };
        }
      }
      if (!bestHospital) return res.status(404).json({ success: false, message: 'No suitable hospital found.' });
      const donorToken = await generateUniqueDonorToken(await pool.connect());
      const qrToken = generateQRToken();
      const etaMinutes = Math.round((bestHospital.donorDist / 40) * 60);
      const expectedTime = new Date(Date.now() + etaMinutes * 60 * 1000);
      await pool.query(`INSERT INTO donation_commitments (request_id, donor_id, hospital_id, donor_token, status) VALUES ($1, $2, $3, $4, 'committed')`, [requestId, donorId, bestHospital.hospital_id, donorToken]);
      await pool.query(`INSERT INTO donor_checkins (donor_id, hospital_id, request_id, qr_token, expected_time, status) VALUES ($1, $2, $3, $4, $5, 'scheduled')`, [donorId, bestHospital.hospital_id, requestId, qrToken, expectedTime]);
      res.json({ success: true, message: 'Confirmed!', hospital: { name: bestHospital.hospital_name, address: bestHospital.address, pincode: bestHospital.pincode, distance: bestHospital.donorDist.toFixed(1) }, donorToken, qrToken, etaMinutes });
    } catch (e) {
      console.error(e);
      res.status(500).json({ success: false, message: 'Server error.' });
    }
  }
});

// DONOR ETA CALCULATOR
app.post('/api/donor/calculate-eta', async (req, res) => {
  const { donorLat, donorLon, hospitalId } = req.body;
  if (!donorLat || !donorLon || !hospitalId) return res.status(400).json({ success: false, message: 'Missing fields.' });
  try {
    const { rows } = await pool.query('SELECT hospital_name, latitude, longitude, address FROM hospitals WHERE hospital_id = $1', [hospitalId]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Hospital not found.' });
    const hospital = rows[0];
    const distance = calculateDistance(donorLat, donorLon, hospital.latitude, hospital.longitude);
    const etaMinutes = Math.round((distance / 40) * 60);
    res.json({ success: true, distance: distance.toFixed(2), etaMinutes, hospital: { name: hospital.hospital_name, address: hospital.address } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// DONOR RELIABILITY SCORE
app.get('/api/donor/reliability-score/:donorId', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM donor_reliability WHERE donor_id = $1', [req.params.donorId]);
    if (!rows.length) {
      await pool.query("INSERT INTO donor_reliability (donor_id) VALUES ($1)", [req.params.donorId]);
      return res.json({ success: true, score: 100, total: 0, successful: 0 });
    }
    res.json({ success: true, score: rows[0].reliability_score, total: rows[0].total_commitments, successful: rows[0].successful_checkins, noShows: rows[0].no_shows, strikes: rows[0].strikes });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// DONOR QR CHECK-IN
app.get('/api/donor/qr-token/:donorId', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT qr_token, expected_time, status, h.hospital_name FROM donor_checkins dc JOIN hospitals h ON dc.hospital_id = h.hospital_id WHERE dc.donor_id = $1 AND dc.status IN ('scheduled', 'arrived') ORDER BY dc.created_at DESC LIMIT 1", [req.params.donorId]);
    if (!rows.length) return res.json({ success: false, message: 'No active appointment.' });
    res.json({ success: true, qrToken: rows[0].qr_token, expectedTime: rows[0].expected_time, status: rows[0].status, hospital: rows[0].hospital_name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/donor/accept-request', async (req, res) => {
  const { requestId, donorId } = req.body;
  if (!requestId || !donorId) return res.status(400).json({ success: false, message: 'requestId and donorId required.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query('SELECT donor_token FROM donation_commitments WHERE request_id = $1 AND donor_id = $2', [requestId, donorId]);
    if (exists.rows.length) {
      await client.query('COMMIT');
      return res.json({ success: true, message: 'Already committed.', donor_token: exists.rows[0].donor_token });
    }
    const donorToken = await generateUniqueDonorToken(client);
    await client.query(`INSERT INTO donation_commitments (request_id, donor_id, donor_token, status) VALUES ($1, $2, $3, 'committed')`, [requestId, donorId, donorToken]);
    await client.query('COMMIT');
    res.status(201).json({ success: true, message: 'Request accepted.', donor_token: donorToken });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  } finally {
    client.release();
  }
});

app.get('/api/sos/active/:donorId', async (req, res) => {
  try {
    const donor = await pool.query('SELECT blood_type FROM users WHERE user_id = $1', [req.params.donorId]);
    if (!donor.rows.length) return res.status(404).json({ success: false, message: 'Donor not found.' });
    const { rows } = await pool.query(`SELECT br.request_id, u.full_name AS patient_name, br.blood_type_needed, br.latitude, br.longitude FROM blood_requests br JOIN users u ON br.patient_id = u.user_id WHERE br.blood_type_needed = $1 AND br.status = 'escalated' AND NOT EXISTS (SELECT 1 FROM donation_commitments dc WHERE dc.request_id = br.request_id AND dc.donor_id = $2) ORDER BY br.created_at DESC`, [donor.rows[0].blood_type, req.params.donorId]);
    res.json({ success: true, requests: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// VOLUNTEER AUTH
app.post('/api/volunteer/generate-otp', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber || !/^\d{10}$/.test(phoneNumber)) return res.status(400).json({ success: false, message: 'Valid 10-digit phone required.' });
  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[phoneNumber] = { otp, expiry: Date.now() + 300000 };
    console.log(`Volunteer OTP for ${phoneNumber}: ${otp}`);
    res.json({ success: true, otp: otp, message: 'OTP generated.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/volunteer/verify-login', async (req, res) => {
  const { type, fullName, ngoName, registrationId, phoneNumber, otp } = req.body;
  const record = otpStore[phoneNumber];
  if (!record || record.otp !== otp || Date.now() >= record.expiry) return res.status(401).json({ success: false, message: 'Invalid or expired OTP.' });
  delete otpStore[phoneNumber];
  try {
    const { rows } = await pool.query("SELECT user_id, full_name, phone_number, role, registration_id FROM users WHERE phone_number = $1 AND (role = 'volunteer' OR role = 'ngo')", [phoneNumber]);
    if (rows.length) {
      const user = rows[0];
      const updateName = (type === 'volunteer') ? fullName : ngoName;
      await pool.query("UPDATE users SET full_name = $1, role = $2, registration_id = $3 WHERE user_id = $4", [updateName, type, (type === 'ngo') ? registrationId : null, user.user_id]);
      user.full_name = updateName;
      user.role = type;
      return res.json({ success: true, message: 'Login successful!', user: user });
    }
    let name = (type === 'volunteer') ? fullName : ngoName;
    let regId = (type === 'ngo') ? registrationId : null;
    const newUser = await pool.query(`INSERT INTO users (full_name, phone_number, role, registration_id) VALUES ($1, $2, $3, $4) RETURNING user_id, full_name, phone_number, role, registration_id`, [name, phoneNumber, type, regId]);
    res.status(201).json({ success: true, message: 'Registration successful!', user: newUser.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Database error.' });
  }
});

// VOLUNTEER DRIVES
app.get('/api/volunteer/drives', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT d.*, u.full_name as organizer_name FROM donation_drives d JOIN users u ON d.organizer_id = u.user_id WHERE d.status = 'upcoming' ORDER BY d.start_date ASC`);
    res.json({ success: true, drives: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/volunteer/drive-create', async (req, res) => {
  const { organizerId, driveName, location, startDate, endDate, startTime, endTime, targetDonors, roles } = req.body;
  if (!organizerId || !driveName || !location || !startDate) return res.status(400).json({ success: false, message: 'Missing fields.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`INSERT INTO donation_drives (organizer_id, drive_name, location, start_date, end_date, start_time, end_time, target_donors) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING drive_id`, [organizerId, driveName, location, startDate, endDate, startTime, endTime, targetDonors]);
    const driveId = rows[0].drive_id;
    if (roles && roles.length) {
      for (const role of roles) {
        await client.query('INSERT INTO volunteer_roles (drive_id, role_name, required_volunteers) VALUES ($1, $2, $3)', [driveId, role.name, role.required]);
      }
    }
    await client.query('COMMIT');
    res.status(201).json({ success: true, message: 'Drive created', driveId });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  } finally {
    client.release();
  }
});

app.post('/api/volunteer/drive-signup', async (req, res) => {
  const { volunteerId, roleId, shiftStart, shiftEnd } = req.body;
  if (!volunteerId || !roleId) return res.status(400).json({ success: false, message: 'Missing fields.' });
  try {
    await pool.query('INSERT INTO volunteer_assignments (volunteer_id, role_id, shift_start, shift_end) VALUES ($1, $2, $3, $4)', [volunteerId, roleId, shiftStart, shiftEnd]);
    await pool.query('UPDATE volunteer_roles SET assigned_volunteers = assigned_volunteers + 1 WHERE role_id = $1', [roleId]);
    res.json({ success: true, message: 'Signed up successfully!' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.get('/api/volunteer/my-assignments/:volunteerId', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT va.*, vr.role_name, d.drive_name, d.location, d.start_date FROM volunteer_assignments va JOIN volunteer_roles vr ON va.role_id = vr.role_id JOIN donation_drives d ON vr.drive_id = d.drive_id WHERE va.volunteer_id = $1 ORDER BY d.start_date DESC`, [req.params.volunteerId]);
    res.json({ success: true, assignments: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// AWARENESS KIT
app.post('/api/awareness/generate-material', async (req, res) => {
  const { createdBy, materialType, title } = req.body;
  if (!createdBy || !materialType || !title) return res.status(400).json({ success: false, message: 'Missing fields.' });
  try {
    const qrData = `https://lifelink.app/pledge?ref=${Math.random().toString(36).substr(2, 9)}`;
    const contentUrl = `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect fill="%23fff" width="400" height="600"/><text x="200" y="100" text-anchor="middle" font-size="24" font-weight="bold">${encodeURIComponent(title)}</text><text x="200" y="300" text-anchor="middle" font-size="16">Scan to Pledge</text></svg>`;
    const { rows } = await pool.query('INSERT INTO awareness_materials (created_by, material_type, title, content_url, qr_code_data) VALUES ($1, $2, $3, $4, $5) RETURNING *', [createdBy, materialType, title, contentUrl, qrData]);
    res.json({ success: true, material: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// COORDINATOR VERIFICATION QUEUE
app.get('/api/coordinator/queue', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT vq.*, br.blood_type_needed, br.component_needed, u.full_name as submitted_by_name FROM verification_queue vq JOIN blood_requests br ON vq.request_id = br.request_id LEFT JOIN users u ON vq.submitted_by = u.user_id WHERE vq.status = 'pending' ORDER BY vq.priority DESC, vq.submitted_at ASC`);
    res.json({ success: true, queue: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/coordinator/verify-request', async (req, res) => {
  const { queueId, coordinatorId, action, notes } = req.body;
  if (!queueId || !coordinatorId || !action) return res.status(400).json({ success: false, message: 'Missing fields.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("UPDATE verification_queue SET status = $1, verified_by = $2, verification_notes = $3, processed_at = NOW() WHERE queue_id = $4", [action, coordinatorId, notes, queueId]);
    const { rows } = await client.query('SELECT request_id FROM verification_queue WHERE queue_id = $1', [queueId]);
    if (action === 'approved') {
      await client.query("UPDATE blood_requests SET verification_status = 'verified' WHERE request_id = $1", [rows[0].request_id]);
    } else {
      await client.query("UPDATE blood_requests SET verification_status = 'rejected', status = 'rejected' WHERE request_id = $1", [rows[0].request_id]);
    }
    await client.query('COMMIT');
    res.json({ success: true, message: `Request ${action}` });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  } finally {
    client.release();
  }
});

// COORDINATOR SOS MONITOR
app.get('/api/coordinator/sos-monitor', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT br.*, u.full_name as patient_name, h.hospital_name FROM blood_requests br LEFT JOIN users u ON br.patient_id = u.user_id LEFT JOIN hospitals h ON br.accepted_by_hospital_id = h.hospital_id WHERE br.status IN ('pending', 'escalated', 'accepted') ORDER BY br.created_at DESC LIMIT 50`);
    res.json({ success: true, requests: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// COORDINATOR COMMS HUB
app.get('/api/coordinator/templates', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM message_templates WHERE is_approved = TRUE ORDER BY template_name');
    res.json({ success: true, templates: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/coordinator/broadcast-message', async (req, res) => {
  const { templateId, recipients, customContent } = req.body;
  if (!templateId || !recipients || !recipients.length) return res.status(400).json({ success: false, message: 'Missing fields.' });
  try {
    const { rows: template } = await pool.query('SELECT * FROM message_templates WHERE template_id = $1', [templateId]);
    if (!template.length) return res.status(404).json({ success: false, message: 'Template not found.' });
    const content = customContent || template[0].content;
    for (const userId of recipients) {
      await pool.query('INSERT INTO sent_messages (template_id, sent_to, message_type, content) VALUES ($1, $2, $3, $4)', [templateId, userId, template[0].template_type, content]);
    }
    res.json({ success: true, message: `Message sent to ${recipients.length} recipients` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ADMIN AUTH & SETTINGS
app.post('/api/server/register/admin', async (req, res) => {
  const { fullName, pincode, phoneNumber, password } = req.body;
  try {
    const existing = await pool.query('SELECT 1 FROM users WHERE phone_number = $1', [phoneNumber]);
    if (existing.rows.length) return res.status(409).json({ success: false, message: 'Phone already registered.' });
    await pool.query("INSERT INTO users (full_name, phone_number, pincode, role, password_hash) VALUES ($1, $2, $3, 'admin', $4) RETURNING user_id", [fullName, phoneNumber, pincode, password]);
    res.status(201).json({ success: true, message: 'Admin registered successfully.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/server/login/admin', async (req, res) => {
  const { phoneNumber, password } = req.body;
  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE phone_number = $1 AND role = 'admin'", [phoneNumber]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Admin not found.' });
    const user = rows[0];
    if (password !== user.password_hash) return res.status(401).json({ success: false, message: 'Invalid password.' });
    res.json({ success: true, user: { fullName: user.full_name, userId: user.user_id } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.get('/api/server/requests/live', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT br.request_id, br.blood_type_needed, br.status, u.full_name AS patient_name, h.hospital_name FROM blood_requests br JOIN users u ON br.patient_id = u.user_id LEFT JOIN hospitals h ON h.hospital_id = br.accepted_by_hospital_id WHERE br.status IN ('pending', 'accepted', 'escalated') ORDER BY br.created_at DESC LIMIT 20`);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json([]);
  }
});

app.get('/api/server/camps', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT c.camp_id, c.camp_name, c.address, c.camp_date, n.ngo_name FROM camps c LEFT JOIN ngos n ON c.organizer_ngo_id = n.ngo_id WHERE c.camp_date >= CURRENT_DATE ORDER BY c.camp_date ASC`);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.json([]);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LifeLink Enhanced Server running on port ${PORT}`);
});

module.exports = app;