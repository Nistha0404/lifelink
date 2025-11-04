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

// ================================================================
// PATIENT AUTH
// ================================================================
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

// ================================================================
// PATIENT SOS
// ================================================================
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
    const { rows } = await pool.query(`SELECT br.*, h.hospital_name, h.phone_number as hospital_phone FROM blood_requests br LEFT JOIN hospitals h ON br.accepted_by_hospital_id = h.hospital_id WHERE br.request_id = $1`, [req.params.requestId]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Request not found.' });
    res.json({ success: true, request: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ================================================================
// DONOR AUTH & FUNCTIONALITY
// ================================================================
app.post('/api/server/donor/generate-otp', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber || !/^\d{10}$/.test(phoneNumber)) {
    return res.status(400).json({ success: false, message: 'Valid 10-digit phone required.' });
  }
  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[phoneNumber] = { otp, expiry: Date.now() + 300000 };
    console.log(`Donor OTP for ${phoneNumber}: ${otp}`);
    res.json({ success: true, otp, message: 'OTP generated.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/server/donor/register-request', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber || !/^\d{10}$/.test(phoneNumber)) {
    return res.status(400).json({ success: false, message: 'Valid 10-digit phone required.' });
  }
  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[phoneNumber] = { otp, expiry: Date.now() + 300000 };
    console.log(`Donor Registration OTP for ${phoneNumber}: ${otp}`);
    res.json({ success: true, otp, message: 'OTP sent for registration.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/server/donor/register-confirm', async (req, res) => {
  const { fullName, phoneNumber, pincode, bloodType, otp } = req.body;
  const record = otpStore[phoneNumber];
  if (!record || record.otp !== otp || Date.now() >= record.expiry) {
    return res.status(401).json({ success: false, message: 'Invalid or expired OTP.' });
  }
  delete otpStore[phoneNumber];
  
  try {
    const existing = await pool.query("SELECT * FROM users WHERE phone_number = $1", [phoneNumber]);
    if (existing.rows.length) {
      return res.status(409).json({ success: false, message: 'Phone number already registered.' });
    }
    
    const { rows } = await pool.query(
      "INSERT INTO users (full_name, phone_number, pincode, blood_type, role) VALUES ($1, $2, $3, $4, 'donor') RETURNING *",
      [fullName, phoneNumber, pincode, bloodType]
    );
    res.status(201).json({ success: true, message: 'Registration successful!', user: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Database error.' });
  }
});

app.post('/api/server/donor/login', async (req, res) => {
  const { phoneNumber, otp } = req.body;
  const record = otpStore[phoneNumber];
  if (!record || record.otp !== otp || Date.now() >= record.expiry) {
    return res.status(401).json({ success: false, message: 'Invalid or expired OTP.' });
  }
  delete otpStore[phoneNumber];
  
  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE phone_number = $1 AND role = 'donor'", [phoneNumber]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Donor not found. Please register first.' });
    }
    
    await pool.query("UPDATE users SET last_login = NOW() WHERE user_id = $1", [rows[0].user_id]);
    res.json({ success: true, message: 'Login successful!', user: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Database error.' });
  }
});

// ================================================================
// HOSPITAL AUTH & FUNCTIONALITY
// ================================================================
app.post('/api/server/hospital-register', async (req, res) => {
  const { hospitalName, address, pincode, phoneNumber, password } = req.body;
  if (!hospitalName || !address || !pincode || !phoneNumber || !password) {
    return res.status(400).json({ success: false, message: 'All fields are required.' });
  }
  
  try {
    const existing = await pool.query('SELECT 1 FROM hospitals WHERE phone_number = $1', [phoneNumber]);
    if (existing.rows.length) {
      return res.status(409).json({ success: false, message: 'Phone number already registered.' });
    }
    
    // Generate unique hospital ID
    const count = await pool.query('SELECT COUNT(*) FROM hospitals');
    const nextId = parseInt(count.rows[0].count) + 101;
    const hospitalId = `HOS${nextId}`;
    
    await pool.query(
      'INSERT INTO hospitals (hospital_id, hospital_name, address, pincode, phone_number, password_hash) VALUES ($1, $2, $3, $4, $5, $6)',
      [hospitalId, hospitalName, address, pincode, phoneNumber, password]
    );
    
    res.status(201).json({ success: true, message: 'Hospital registered successfully!', hospitalId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/server/hospital-login', async (req, res) => {
  const { hospitalId, password } = req.body;
  if (!hospitalId || !password) {
    return res.status(400).json({ success: false, message: 'Hospital ID and password required.' });
  }
  
  try {
    const { rows } = await pool.query('SELECT * FROM hospitals WHERE hospital_id = $1', [hospitalId]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Hospital not found.' });
    }
    
    if (rows[0].password_hash !== password) {
      return res.status(401).json({ success: false, message: 'Invalid password.' });
    }
    
    res.json({ success: true, message: 'Login successful!', hospital: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ================================================================
// ADMIN AUTH
// ================================================================
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

// ================================================================
// ADMIN DASHBOARD DATA
// ================================================================
app.get('/api/server/requests/live', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT br.request_id, br.blood_type_needed, br.status, br.created_at, u.full_name AS patient_name, h.hospital_name FROM blood_requests br JOIN users u ON br.patient_id = u.user_id LEFT JOIN hospitals h ON h.hospital_id = br.accepted_by_hospital_id WHERE br.status IN ('pending', 'accepted', 'escalated') ORDER BY br.created_at DESC LIMIT 20`);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json([]);
  }
});

app.get('/api/server/camps', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT d.drive_id as camp_id, d.drive_name as camp_name, d.location as address, d.start_date as camp_date, u.full_name as ngo_name FROM donation_drives d LEFT JOIN users u ON d.organizer_id = u.user_id WHERE d.start_date >= CURRENT_DATE ORDER BY d.start_date ASC`);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.json([]);
  }
});

// ================================================================
// VOLUNTEER AUTH
// ================================================================
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

// ================================================================
// VOLUNTEER DRIVES - CRITICAL MISSING ENDPOINTS
// ================================================================

// GET AVAILABLE DRIVES FOR VOLUNTEERS TO SIGN UP
app.get('/api/volunteer/drives-available', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        d.drive_id, 
        d.drive_name, 
        d.location, 
        d.start_date, 
        d.end_date,
        d.start_time, 
        d.end_time, 
        d.target_donors, 
        d.registered_donors,
        d.status,
        u.full_name as organizer_name 
      FROM donation_drives d 
      LEFT JOIN users u ON d.organizer_id = u.user_id 
      WHERE d.start_date >= CURRENT_DATE 
      ORDER BY d.start_date ASC
    `);
    res.json({ success: true, drives: rows });
  } catch (e) {
    console.error('Error fetching drives:', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

// GET ROLES FOR SPECIFIC DRIVE
app.get('/api/volunteer/drive-roles/:driveId', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        role_id, 
        role_name, 
        required_volunteers, 
        assigned_volunteers 
      FROM volunteer_roles 
      WHERE drive_id = $1
    `, [req.params.driveId]);
    res.json({ success: true, roles: rows });
  } catch (e) {
    console.error('Error fetching roles:', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

// EXISTING DRIVE ENDPOINTS (KEPT AS IS)
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

// ================================================================
// AWARENESS KIT
// ================================================================
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

// ================================================================
// VERCEL SERVERLESS EXPORT
// ================================================================

// For local development
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`LifeLink Enhanced Server running on port ${PORT}`);
  });
}

// For Vercel serverless deployment
module.exports = app;