const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Database Connection
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: { rejectUnauthorized: false },
});

// Environment Variables
const FAST2SMS_API_KEY = process.env.FAST2SMS_API_KEY;
const OPENCAGE_API_KEY = process.env.OPENCAGE_API_KEY;

// In-memory OTP storage
const otpStore = {};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function calculateDistance(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return Infinity;
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function generate4DigitToken() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

async function generateUniquePatientToken(client) {
  for (let i = 0; i < 10; i++) {
    const token = generate4DigitToken();
    const { rows } = await client.query(
      "SELECT 1 FROM blood_requests WHERE patient_token = $1 AND status IN ('pending','accepted')",
      [token]
    );
    if (rows.length === 0) return token;
  }
  return generate4DigitToken();
}

async function generateUniqueDonorToken(client) {
  for (let i = 0; i < 10; i++) {
    const token = generate4DigitToken();
    const { rows } = await client.query(
      'SELECT 1 FROM donation_commitments WHERE donor_token = $1',
      [token]
    );
    if (rows.length === 0) return token;
  }
  throw new Error('Could not generate unique donor token.');
}

// ============================================================================
// ESCALATION LOGIC - Automatically escalate to donors
// ============================================================================

async function checkAndEscalate(requestId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const reqRes = await client.query(
      "SELECT status, blood_type_needed, latitude, longitude FROM blood_requests WHERE request_id = $1 FOR UPDATE",
      [requestId]
    );
    
    if (!reqRes.rows.length || reqRes.rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return;
    }

    const sentAlerts = await client.query(
      "SELECT 1 FROM alert_status WHERE request_id = $1 AND status = 'sent'",
      [requestId]
    );

    if (sentAlerts.rows.length === 0) {
      console.log(`🚨 Escalating request ${requestId} to donors...`);
      
      await client.query(
        "UPDATE blood_requests SET status = 'escalated' WHERE request_id = $1",
        [requestId]
      );
      
      // Get matching donors
      const { rows: donors } = await client.query(
        "SELECT user_id, phone_number, full_name FROM users WHERE role = 'donor' AND blood_type = $1",
        [reqRes.rows[0].blood_type_needed]
      );
      
      console.log(`📢 Notified ${donors.length} donors for request ${requestId}`);
      
      // Here you would send SMS/push notifications to donors
      // For now, just log it
    }
    
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`Error in checkAndEscalate: ${e.message}`);
  } finally {
    client.release();
  }
}

// ============================================================================
// PATIENT AUTHENTICATION
// ============================================================================

app.post('/api/server/send-otp', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ success: false, message: 'Phone number required.' });
  
  try {
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    otpStore[phoneNumber] = { otp, expiry: Date.now() + 300000 };
    
    console.log(`📱 Patient OTP for ${phoneNumber}: ${otp}`);
    
    res.json({ success: true, otp, message: 'OTP generated.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/server/patient-login', async (req, res) => {
  const { phoneNumber, fullName, pincode, otp } = req.body;
  
  // Verify OTP
  const record = otpStore[phoneNumber];
  if (!record || record.otp !== otp || Date.now() >= record.expiry) {
    return res.status(401).json({ success: false, message: 'Invalid or expired OTP.' });
  }
  delete otpStore[phoneNumber];
  
  try {
    const existing = await pool.query(
      "SELECT * FROM users WHERE phone_number = $1 AND role = 'patient'",
      [phoneNumber]
    );
    
    if (existing.rows.length) {
      const updateQuery = `
        UPDATE users SET full_name = $1, pincode = $2, last_login = NOW()
        WHERE phone_number = $3 AND role = 'patient'
        RETURNING *`;
      const { rows } = await pool.query(updateQuery, [fullName, pincode, phoneNumber]);
      return res.json({ success: true, message: 'Login successful!', user: rows[0] });
    }
    
    if (!fullName || !pincode) {
      return res.status(400).json({ success: false, message: 'Name and pincode required for registration.' });
    }
    
    const insertQuery = `
      INSERT INTO users (full_name, phone_number, role, pincode)
      VALUES ($1, $2, 'patient', $3) RETURNING *`;
    const { rows } = await pool.query(insertQuery, [fullName, phoneNumber, pincode]);
    res.status(201).json({ success: true, message: 'Registration successful!', user: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Database error.' });
  }
});

// ============================================================================
// PATIENT SOS - Core Workflow Step 1
// ============================================================================

app.post('/api/server/request-blood', async (req, res) => {
  const { patientId, bloodType, pincode, latitude, longitude } = req.body;
  
  if (!patientId || !bloodType) {
    return res.status(400).json({ success: false, message: 'Missing required fields.' });
  }
  if (!latitude || !longitude) {
    return res.status(400).json({ success: false, message: 'Precise location is required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const patientToken = await generateUniquePatientToken(client);
    const deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // Create blood request
    const insertRequest = `
      INSERT INTO blood_requests (patient_id, creator_user_id, blood_type_needed, pincode, latitude, longitude, status, patient_token, deadline)
      VALUES ($1, $1, $2, $3, $4, $5, 'pending', $6, $7)
      RETURNING request_id, patient_token`;
      
    const { rows } = await client.query(insertRequest, [patientId, bloodType, pincode, latitude, longitude, patientToken, deadline]);
    const requestId = rows[0].request_id;

    // Find hospitals within 10km
    const { rows: hospitals } = await client.query('SELECT hospital_id, latitude, longitude FROM hospitals');
    const alertPromises = [];
    
    for (const hospital of hospitals) {
      const distance = calculateDistance(latitude, longitude, hospital.latitude, hospital.longitude);
      
      if (distance <= 10) {
        alertPromises.push(
          client.query(
            'INSERT INTO alert_status (request_id, hospital_id, distance_km, status) VALUES ($1, $2, $3, $4)',
            [requestId, hospital.hospital_id, distance.toFixed(2), 'sent']
          )
        );
      }
    }
    
    await Promise.all(alertPromises);
    await client.query('COMMIT');

    // Set 10-minute escalation timer
    setTimeout(() => {
      checkAndEscalate(requestId);
    }, 10 * 60 * 1000 + 1000);

    res.status(201).json({ 
      success: true, 
      message: `SOS sent to ${alertPromises.length} hospitals!`, 
      requestId, 
      patient_token: rows[0].patient_token 
    });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  } finally {
    client.release();
  }
});

// Patient checks request status
app.get('/api/server/request-status/:requestId', async (req, res) => {
  const { requestId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT br.status, br.patient_token, h.hospital_name, h.pincode, h.address
       FROM blood_requests br
       LEFT JOIN hospitals h ON h.hospital_id = br.accepted_by_hospital_id
       WHERE br.request_id = $1`,
      [requestId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ status: 'not_found' });
    }

    const request = rows[0];
    
    if (request.status === 'accepted') {
      res.json({ 
        status: 'accepted', 
        hospital: { 
          name: request.hospital_name, 
          pincode: request.pincode,
          address: request.address 
        },
        patient_token: request.patient_token
      });
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

// Patient request history
app.get('/api/server/requests/history/:patientId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT br.request_id, br.blood_type_needed, br.pincode, br.status, br.created_at, br.patient_token,
              h.hospital_name
       FROM blood_requests br
       LEFT JOIN hospitals h ON h.hospital_id = br.accepted_by_hospital_id
       WHERE br.patient_id = $1 
       ORDER BY br.created_at DESC`,
      [req.params.patientId]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json([]);
  }
});

// ============================================================================
// HOSPITAL AUTHENTICATION
// ============================================================================

app.post('/api/server/hospital-register', async (req, res) => {
  const { hospitalName, address, pincode, phoneNumber, password } = req.body;
  
  if (!hospitalName || !pincode || !phoneNumber || !password || !address) {
    return res.status(400).json({ success: false, message: 'All fields required.' });
  }

  let latitude = null;
  let longitude = null;
  
  try {
    const fullAddress = `${address}, ${pincode}`;
    const geoResponse = await axios.get('https://api.opencagedata.com/geocode/v1/json', {
      params: {
        q: fullAddress,
        key: OPENCAGE_API_KEY,
        limit: 1,
        countrycode: 'in'
      }
    });

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
    if (existing.rows.length) {
      return res.status(409).json({ success: false, message: 'Phone already registered.' });
    }

    const last = await pool.query('SELECT hospital_id FROM hospitals ORDER BY hospital_id DESC LIMIT 1');
    const nextNum = last.rows.length ? parseInt(last.rows[0].hospital_id.replace('HOS','')) + 1 : 101;
    const newId = `HOS${nextNum}`;

    const insertQuery = `
      INSERT INTO hospitals (hospital_id, hospital_name, address, pincode, phone_number, password_hash, blood_inventory, latitude, longitude)
      VALUES ($1, $2, $3, $4, $5, $6, '{}', $7, $8) 
      RETURNING hospital_id`;
    
    const { rows } = await pool.query(insertQuery, [newId, hospitalName, address, pincode, phoneNumber, password, latitude, longitude]);

    res.status(201).json({ success: true, hospitalId: rows[0].hospital_id });
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
    const { rows } = await pool.query('SELECT * FROM hospitals WHERE hospital_id = $1', [hospitalId.toUpperCase()]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Hospital not found.' });
    }
    
    const hospital = rows[0];
    if (password !== hospital.password_hash) {
      return res.status(401).json({ success: false, message: 'Invalid password.' });
    }
    
    const { password_hash, ...safeHospital } = hospital;
    res.json({ success: true, hospital: safeHospital });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ============================================================================
// HOSPITAL SOS MONITOR - Core Workflow Step 2
// ============================================================================

app.get('/api/server/sos-alerts/:hospitalId', async (req, res) => {
  const { hospitalId } = req.params;
  try {
    const query = `
      SELECT 
        br.request_id,
        br.blood_type_needed,
        br.patient_token,
        br.deadline,
        u.full_name AS patient_name,
        als.distance_km
      FROM alert_status als
      JOIN blood_requests br ON als.request_id = br.request_id
      JOIN users u ON br.patient_id = u.user_id
      WHERE als.hospital_id = $1
        AND als.status = 'sent'
        AND br.status = 'pending'
      ORDER BY als.created_at DESC
    `;
    const { rows } = await pool.query(query, [hospitalId.toUpperCase()]);

    const alerts = rows.map(req => ({
      requestId: req.request_id,
      patientName: req.patient_name,
      bloodType: req.blood_type_needed,
      patientToken: req.patient_token,
      distance: parseFloat(req.distance_km),
      deadline: req.deadline
    }));

    res.json(alerts);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: 'Server error.' });
  }
});

// Hospital accepts/rejects SOS
app.post('/api/server/hospital-response', async (req, res) => {
  const { requestId, hospitalId, response } = req.body;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const reqRes = await client.query(
      "SELECT status FROM blood_requests WHERE request_id = $1 FOR UPDATE",
      [requestId]
    );
    
    if (!reqRes.rows.length || reqRes.rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Request no longer active.' });
    }

    if (response === 'accept') {
      await client.query(
        "UPDATE alert_status SET status = 'accepted', response_at = NOW() WHERE request_id = $1 AND hospital_id = $2",
        [requestId, hospitalId]
      );
      
      await client.query(
        "UPDATE alert_status SET status = 'closed', response_at = NOW() WHERE request_id = $1 AND hospital_id != $2 AND status = 'sent'",
        [requestId, hospitalId]
      );
      
      await client.query(
        "UPDATE blood_requests SET status = 'accepted', accepted_by_hospital_id = $1 WHERE request_id = $2",
        [hospitalId, requestId]
      );
    } else {
      await client.query(
        "UPDATE alert_status SET status = 'rejected', response_at = NOW() WHERE request_id = $1 AND hospital_id = $2",
        [requestId, hospitalId]
      );
    }
    
    await client.query('COMMIT');
    
    if (response === 'reject') {
      checkAndEscalate(requestId);
    }
    
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  } finally {
    client.release();
  }
});

// Hospital inventory management
app.post('/api/server/update-inventory', async (req, res) => {
  const { hospitalId, inventory } = req.body;
  if (!hospitalId || !inventory) {
    return res.status(400).json({ success: false, message: 'Missing data.' });
  }
  
  try {
    await pool.query('UPDATE hospitals SET blood_inventory = $1 WHERE hospital_id = $2', [inventory, hospitalId]);
    res.json({ success: true, message: 'Stock updated.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// Hospital token verification
app.post('/api/server/verify-token', async (req, res) => {
  const { token } = req.body;
  if (!token || token.length !== 4) {
    return res.status(400).json({ success: false, message: '4-digit token required.' });
  }
  
  try {
    // Check patient token
    const patientQuery = `
      SELECT br.request_id, br.patient_id, br.patient_token, br.blood_type_needed, br.pincode,
             u.full_name AS patient_name
      FROM blood_requests br
      JOIN users u ON u.user_id = br.patient_id
      WHERE br.patient_token = $1
      LIMIT 1`;
    const patientResult = await pool.query(patientQuery, [token]);
    
    if (patientResult.rows.length) {
      const r = patientResult.rows[0];
      return res.json({
        success: true,
        type: 'patient',
        request_id: r.request_id,
        patient_token: r.patient_token,
        patient: {
          user_id: r.patient_id,
          full_name: r.patient_name,
          blood_type_needed: r.blood_type_needed,
          pincode: r.pincode
        }
      });
    }

    // Check donor token
    const donorQuery = `
      SELECT dc.commitment_id, dc.request_id, dc.donor_id, dc.donor_token, dc.status AS commitment_status,
             du.full_name AS donor_name, du.blood_type AS donor_blood_type,
             br.patient_token
      FROM donation_commitments dc
      JOIN users du ON du.user_id = dc.donor_id
      JOIN blood_requests br ON br.request_id = dc.request_id
      WHERE dc.donor_token = $1
      LIMIT 1`;
    const donorResult = await pool.query(donorQuery, [token]);
    
    if (donorResult.rows.length) {
      const r = donorResult.rows[0];
      return res.json({
        success: true,
        type: 'donor',
        donor_token: r.donor_token,
        donor: {
          user_id: r.donor_id,
          full_name: r.donor_name,
          blood_type: r.donor_blood_type
        },
        matched_patient_token: r.patient_token,
        request_id: r.request_id
      });
    }

    res.status(404).json({ success: false, message: 'Token not found.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ============================================================================
// DONOR AUTHENTICATION
// ============================================================================

app.post('/api/server/donor/generate-otp', async (req, res) => {
  const { phoneNumber } = req.body;
  try {
    const { rows } = await pool.query(
      "SELECT user_id FROM users WHERE phone_number = $1 AND role = 'donor'",
      [phoneNumber]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Not a registered donor.' });
    }
    
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[phoneNumber] = { otp, expiry: Date.now() + 300000 };
    console.log(`📱 Donor OTP for ${phoneNumber}: ${otp}`);
    res.json({ success: true, otp, message: 'OTP generated.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/server/donor/login', async (req, res) => {
  const { phoneNumber, otp } = req.body;
  const record = otpStore[phoneNumber];
  if (!record || record.otp !== otp || Date.now() >= record.expiry) {
    return res.status(401).json({ success: false, message: 'Invalid or expired OTP.' });
  }
  
  try {
    delete otpStore[phoneNumber];
    const { rows } = await pool.query(
      "SELECT user_id, full_name, phone_number, pincode, blood_type, role FROM users WHERE phone_number = $1 AND role = 'donor'",
      [phoneNumber]
    );
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
    if (existing.rows.length) {
      return res.status(409).json({ success: false, message: 'Phone already registered.' });
    }
    
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[phoneNumber] = { otp, expiry: Date.now() + 300000 };
    console.log(`📱 Donor registration OTP for ${phoneNumber}: ${otp}`);
    res.json({ success: true, otp, message: 'OTP sent.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/server/donor/register-confirm', async (req, res) => {
  const { fullName, phoneNumber, pincode, bloodType, otp } = req.body;
  const record = otpStore[phoneNumber];
  if (!record || record.otp !== otp || Date.now() >= record.expiry) {
    return res.status(400).json({ success: false, message: 'Invalid or expired OTP.' });
  }
  
  try {
    const insertQuery = `
      INSERT INTO users (full_name, phone_number, pincode, blood_type, role)
      VALUES ($1, $2, $3, $4, 'donor') RETURNING user_id`;
    await pool.query(insertQuery, [fullName, phoneNumber, pincode, bloodType.toUpperCase()]);
    delete otpStore[phoneNumber];
    res.status(201).json({ success: true, message: 'Registration successful!' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ============================================================================
// DONOR ACCEPTS REQUEST - Core Workflow Step 3
// ============================================================================

app.post('/api/donor/accept-request', async (req, res) => {
  const { requestId, donorId } = req.body;
  if (!requestId || !donorId) {
    return res.status(400).json({ success: false, message: 'requestId and donorId required.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const reqRow = await client.query(
      'SELECT request_id, status FROM blood_requests WHERE request_id = $1',
      [requestId]
    );
    if (!reqRow.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Request not found.' });
    }

    const donorRow = await client.query(
      "SELECT user_id FROM users WHERE user_id = $1 AND role = 'donor'",
      [donorId]
    );
    if (!donorRow.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Donor not found.' });
    }

    const exists = await client.query(
      'SELECT donor_token FROM donation_commitments WHERE request_id = $1 AND donor_id = $2',
      [requestId, donorId]
    );
    if (exists.rows.length) {
      await client.query('COMMIT');
      return res.json({ success: true, message: 'Already committed.', donor_token: exists.rows[0].donor_token });
    }

    const donorToken = await generateUniqueDonorToken(client);
    const insertCommitment = await client.query(
      `INSERT INTO donation_commitments (request_id, donor_id, donor_token, status)
       VALUES ($1, $2, $3, 'committed')
       RETURNING commitment_id, donor_token`,
      [requestId, donorId, donorToken]
    );

    await client.query('COMMIT');
    res.status(201).json({ success: true, message: 'Request accepted.', donor_token: insertCommitment.rows[0].donor_token });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  } finally {
    client.release();
  }
});

// ============================================================================
// CASUAL DONATION SCHEDULING
// ============================================================================

app.post('/api/donor/schedule-casual-donation', async (req, res) => {
  const { donorId, latitude, longitude, pincode, bloodType, date, timeSlot } = req.body;

  if (!donorId || !bloodType || !date || !timeSlot) {
    return res.status(400).json({ success: false, message: 'Missing required fields.' });
  }

  const donorToken = generate4DigitToken();
  
  try {
    let findHospitalQuery;
    let queryParams;

    if (latitude && longitude) {
      findHospitalQuery = `
        SELECT hospital_id, hospital_name, latitude, longitude,
          (6371 * acos(
            cos(radians($1)) * cos(radians(latitude)) *
            cos(radians(longitude) - radians($2)) +
            sin(radians($1)) * sin(radians(latitude))
          )) AS distance
        FROM hospitals
        HAVING (
          6371 * acos(
            cos(radians($1)) * cos(radians(latitude)) *
            cos(radians(longitude) - radians($2)) +
            sin(radians($1)) * sin(radians(latitude))
          )
        ) < 10
        ORDER BY distance ASC
        LIMIT 1`;
      queryParams = [latitude, longitude];
    } else if (pincode) {
      findHospitalQuery = `
        SELECT hospital_id, hospital_name 
        FROM hospitals 
        WHERE pincode = $1 
        LIMIT 1`;
      queryParams = [pincode];
    } else {
      return res.status(400).json({ success: false, message: 'No location or pincode provided.' });
    }

    const hospitalRes = await pool.query(findHospitalQuery, queryParams);

    if (hospitalRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No hospitals found within 10km.' });
    }

    const hospital = hospitalRes.rows[0];

    const commitQuery = `
      INSERT INTO donation_commitments (donor_id, hospital_id, donor_token, status)
      VALUES ($1, $2, $3, 'scheduled')
      RETURNING *`;
    await pool.query(commitQuery, [donorId, hospital.hospital_id, donorToken]);

    res.status(201).json({ success: true, hospital: hospital });
  } catch (err) {
    console.error('Scheduling Error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.get('/api/donor/active-token/:donorId', async (req, res) => {
  const { donorId } = req.params;
  try {
    const query = `
      SELECT 
        dc.donor_token, dc.status, dc.created_at,
        h.hospital_name, h.pincode
      FROM donation_commitments dc
      JOIN hospitals h ON dc.hospital_id = h.hospital_id
      WHERE dc.donor_id = $1 
        AND dc.status IN ('scheduled', 'committed')
      ORDER BY dc.created_at DESC
      LIMIT 1`;
    const { rows } = await pool.query(query, [donorId]);

    if (rows.length > 0) {
      res.json({ 
        success: true, 
        commitment: rows[0],
        hospital: {
          hospital_name: rows[0].hospital_name,
          pincode: rows[0].pincode
        }
      });
    } else {
      res.json({ success: false, message: 'No active commitment.' });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// Get escalated SOS requests for donors
app.get('/api/sos/active/:donorId', async (req, res) => {
  const { donorId } = req.params;
  try {
    const donor = await pool.query('SELECT blood_type FROM users WHERE user_id = $1', [donorId]);
    if (!donor.rows.length) {
      return res.status(404).json({ success: false, message: 'Donor not found.' });
    }
    const { blood_type } = donor.rows[0];

    const requests = await pool.query(
      `SELECT br.request_id, u.full_name AS patient_name, br.blood_type_needed, br.latitude, br.longitude
       FROM blood_requests br
       JOIN users u ON br.patient_id = u.user_id
       WHERE br.blood_type_needed = $1
         AND br.status = 'escalated'
         AND NOT EXISTS (
           SELECT 1 FROM donation_commitments dc 
           WHERE dc.request_id = br.request_id AND dc.donor_id = $2
         )
       ORDER BY br.created_at DESC`,
      [blood_type, donorId]
    );

    res.json({ success: true, requests: requests.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// Hospital scheduled appointments
app.get('/api/hospital/appointments/:hospitalId', async (req, res) => {
  const { hospitalId } = req.params;

  try {
    const query = `
      SELECT 
        dc.commitment_id, dc.status, dc.created_at,
        u.full_name, u.blood_type
      FROM donation_commitments dc
      JOIN users u ON dc.donor_id = u.user_id
      WHERE dc.hospital_id = $1
        AND dc.status = 'scheduled'
      ORDER BY dc.created_at DESC`;
    const { rows } = await pool.query(query, [hospitalId]);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ============================================================================
// VOLUNTEER & NGO AUTHENTICATION
// ============================================================================

app.post('/api/volunteer/generate-otp', async (req, res) => {
  const { phoneNumber } = req.body;

  if (!phoneNumber || !/^\d{10}$/.test(phoneNumber)) {
    return res.status(400).json({ success: false, message: 'Valid 10-digit phone required.' });
  }

  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[phoneNumber] = { otp, expiry: Date.now() + 300000 };
    console.log(`📱 Volunteer/NGO OTP for ${phoneNumber}: ${otp}`);
    res.json({ success: true, otp: otp, message: 'OTP generated.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/volunteer/verify-login', async (req, res) => {
  const { type, fullName, ngoName, registrationId, phoneNumber, otp } = req.body;

  const record = otpStore[phoneNumber];
  if (!record || record.otp !== otp || Date.now() >= record.expiry) {
    return res.status(401).json({ success: false, message: 'Invalid or expired OTP.' });
  }

  delete otpStore[phoneNumber];

  try {
    const { rows } = await pool.query(
      "SELECT user_id, full_name, phone_number, role, registration_id FROM users WHERE phone_number = $1 AND (role = 'volunteer' OR role = 'ngo')",
      [phoneNumber]
    );

    if (rows.length) {
      const user = rows[0];
      const updateName = (type === 'volunteer') ? fullName : ngoName;
      await pool.query(
        "UPDATE users SET full_name = $1, role = $2, registration_id = $3 WHERE user_id = $4",
        [updateName, type, (type === 'ngo') ? registrationId : null, user.user_id]
      );
      user.full_name = updateName;
      user.role = type;
      return res.json({ success: true, message: 'Login successful!', user: user });
    }
    
    let name = (type === 'volunteer') ? fullName : ngoName;
    let regId = (type === 'ngo') ? registrationId : null;

    const newUser = await pool.query(
      `INSERT INTO users (full_name, phone_number, role, registration_id)
       VALUES ($1, $2, $3, $4)
       RETURNING user_id, full_name, phone_number, role, registration_id`,
      [name, phoneNumber, type, regId]
    );

    res.status(201).json({ success: true, message: 'Registration successful!', user: newUser.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Database error.' });
  }
});

// ============================================================================
// PLAYBOOKS (Hospital Feature)
// ============================================================================

app.get('/api/server/playbooks/:hospitalId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM playbooks WHERE hospital_id = $1 ORDER BY updated_at DESC",
      [req.params.hospitalId]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.json([]);
  }
});

app.post('/api/server/playbooks', async (req, res) => {
  const { hospitalId, title, content } = req.body;
  try {
    const { rows } = await pool.query(
      "INSERT INTO playbooks (hospital_id, title, content) VALUES ($1, $2, $3) RETURNING *",
      [hospitalId, title, content]
    );
    res.status(201).json({ success: true, playbook: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Failed to save playbook.' });
  }
});

// ============================================================================
// ADMIN/COORDINATOR ROUTES
// ============================================================================

app.post('/api/server/register/admin', async (req, res) => {
  const { fullName, pincode, phoneNumber, password } = req.body;
  
  try {
    const existing = await pool.query('SELECT 1 FROM users WHERE phone_number = $1', [phoneNumber]);
    if (existing.rows.length) {
      return res.status(409).json({ success: false, message: 'Phone already registered.' });
    }

    const insertQuery = `
      INSERT INTO users (full_name, phone_number, pincode, role, password_hash)
      VALUES ($1, $2, $3, 'admin', $4)
      RETURNING user_id`;
    await pool.query(insertQuery, [fullName, phoneNumber, pincode, password]);
    
    res.status(201).json({ success: true, message: 'Admin registered successfully.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/server/login/admin', async (req, res) => {
  const { phoneNumber, password } = req.body;
  
  try {
    const { rows } = await pool.query(
      "SELECT * FROM users WHERE phone_number = $1 AND role = 'admin'",
      [phoneNumber]
    );
    
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Admin not found.' });
    }
    
    const user = rows[0];
    if (password !== user.password_hash) {
      return res.status(401).json({ success: false, message: 'Invalid password.' });
    }
    
    res.json({ success: true, user: { fullName: user.full_name, userId: user.user_id } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.get('/api/server/requests/live', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT br.request_id, br.blood_type_needed, br.status,
              u.full_name AS patient_name,
              h.hospital_name
       FROM blood_requests br
       JOIN users u ON br.patient_id = u.user_id
       LEFT JOIN hospitals h ON h.hospital_id = br.accepted_by_hospital_id
       WHERE br.status IN ('pending', 'accepted', 'escalated')
       ORDER BY br.created_at DESC
       LIMIT 20`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json([]);
  }
});

// ============================================================================
// CAMPS (NGO/Volunteer Feature)
// ============================================================================

app.get('/api/server/camps', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.camp_id, c.camp_name, c.address, c.camp_date,
              n.ngo_name
       FROM camps c
       LEFT JOIN ngos n ON c.organizer_ngo_id = n.ngo_id
       WHERE c.camp_date >= CURRENT_DATE
       ORDER BY c.camp_date ASC`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.json([]);
  }
});

// ============================================================================
// SERVER START
// ============================================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ LifeLink Server running on port ${PORT}`);
});

module.exports = app;