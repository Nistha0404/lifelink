const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
const bcrypt = require('bcrypt');

const app = express();
app.use(cors());
app.use(express.json());

// Database connection
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: { rejectUnauthorized: false },
});

// Environment variables
const FAST2SMS_API_KEY = process.env.FAST2SMS_API_KEY;
const OPENCAGE_API_KEY = process.env.OPENCAGE_API_KEY || 'your_opencage_key';

// ADMIN ACCESS CODE (Change this in production!)
const ADMIN_ACCESS_CODE = '1900';

// In-memory OTP storage (use Redis in production)
const otpStore = {};

// In-memory active requests tracking for escalation
const activeRequests = new Map();

// Pincode to Lat/Lon mapping for major Indian pincodes
const PINCODE_COORDS = {
  '147001': { lat: 30.3398, lon: 76.3869 }, // Patiala
  '147002': { lat: 30.3520, lon: 76.4095 },
  '147003': { lat: 30.3216, lon: 76.4250 },
  '147004': { lat: 30.3601, lon: 76.3540 },
  '110001': { lat: 28.6139, lon: 77.2090 }, // Delhi
  '400001': { lat: 18.9388, lon: 72.8354 }, // Mumbai
  '560001': { lat: 12.9716, lon: 77.5946 }, // Bangalore
  '600001': { lat: 13.0827, lon: 80.2707 }, // Chennai
  '700001': { lat: 22.5726, lon: 88.3639 }, // Kolkata
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function calculateDistance(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return Infinity;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) ** 2 + 
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
            Math.sin(dLon/2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function getCoordsFromPincode(pincode) {
  if (PINCODE_COORDS[pincode]) {
    return PINCODE_COORDS[pincode];
  }
  
  if (OPENCAGE_API_KEY && OPENCAGE_API_KEY !== 'your_opencage_key') {
    try {
      const response = await axios.get(`https://api.opencagedata.com/geocode/v1/json`, {
        params: {
          q: `${pincode}, India`,
          key: OPENCAGE_API_KEY,
          limit: 1
        }
      });
      
      if (response.data.results && response.data.results.length > 0) {
        const result = response.data.results[0];
        return {
          lat: result.geometry.lat,
          lon: result.geometry.lng
        };
      }
    } catch (error) {
      console.error('OpenCage API error:', error.message);
    }
  }
  
  return { lat: 23.0, lon: 80.0 };
}

function generate4DigitToken() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function generateOTP() {
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

    const { blood_type_needed, latitude, longitude } = reqRes.rows[0];
    
    const sentAlerts = await client.query(
      "SELECT 1 FROM alert_status WHERE request_id = $1 AND status = 'accepted'", 
      [requestId]
    );
    
    if (sentAlerts.rows.length === 0) {
      console.log(`🚨 Escalating request ${requestId} to donors...`);
      
      await client.query(
        "UPDATE blood_requests SET status = 'escalated' WHERE request_id = $1", 
        [requestId]
      );
      
      const { rows: donors } = await client.query(
        "SELECT user_id, phone_number, full_name, latitude, longitude FROM users WHERE role = 'donor' AND blood_type = $1", 
        [blood_type_needed]
      );
      
      console.log(`📢 Notified ${donors.length} donors for request ${requestId}`);
    }
    
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`❌ Error in checkAndEscalate: ${e.message}`);
  } finally {
    client.release();
  }
}

// ============================================================================
// PATIENT AUTHENTICATION & MANAGEMENT
// ============================================================================

app.post('/api/server/send-otp', async (req, res) => {
  const { phoneNumber } = req.body;
  
  if (!phoneNumber) {
    return res.status(400).json({ success: false, message: 'Phone number required.' });
  }
  
  try {
    const otp = generateOTP();
    otpStore[phoneNumber] = { 
      otp, 
      expiry: Date.now() + 300000
    };
    
    console.log(`📱 Patient OTP for ${phoneNumber}: ${otp}`);
    
    res.json({ 
      success: true, 
      otp,
      message: `OTP generated: ${otp}` 
    });
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
    const existing = await pool.query(
      "SELECT * FROM users WHERE phone_number = $1 AND role = 'patient'", 
      [phoneNumber]
    );
    
    if (existing.rows.length) {
      const { rows } = await pool.query(
        "UPDATE users SET full_name = $1, pincode = $2, last_login = NOW() WHERE phone_number = $3 AND role = 'patient' RETURNING *", 
        [fullName, pincode, phoneNumber]
      );
      return res.json({ 
        success: true, 
        message: 'Login successful!', 
        user: rows[0] 
      });
    }
    
    if (!fullName || !pincode) {
      return res.status(400).json({ 
        success: false, 
        message: 'Name and pincode required for registration.' 
      });
    }
    
    const { rows } = await pool.query(
      "INSERT INTO users (full_name, phone_number, role, pincode) VALUES ($1, $2, 'patient', $3) RETURNING *", 
      [fullName, phoneNumber, pincode]
    );
    
    res.status(201).json({ 
      success: true, 
      message: 'Registration successful!', 
      user: rows[0] 
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Database error.' });
  }
});

// ============================================================================
// PATIENT SOS - CORE WORKFLOW
// ============================================================================

app.post('/api/server/request-blood', async (req, res) => {
  const { patientId, bloodType, pincode, latitude, longitude } = req.body;
  
  console.log('🚨 Received SOS Request:', { patientId, bloodType, pincode, latitude, longitude });
  
  if (!patientId || !bloodType) {
    return res.status(400).json({ success: false, message: 'Missing required fields.' });
  }
  
  let finalLat = latitude;
  let finalLon = longitude;
  let locationSource = 'gps';
  
  if (!latitude || !longitude) {
    if (!pincode) {
      return res.status(400).json({ 
        success: false, 
        message: 'Either precise location or pincode is required.' 
      });
    }
    
    console.log(`📍 Using pincode ${pincode} for location`);
    const coords = await getCoordsFromPincode(pincode);
    finalLat = coords.lat;
    finalLon = coords.lon;
    locationSource = 'pincode';
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const patientToken = await generateUniquePatientToken(client);
    const deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    
    const { rows } = await client.query(
      `INSERT INTO blood_requests 
       (patient_id, blood_type_needed, pincode, latitude, longitude, status, patient_token, deadline) 
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7) 
       RETURNING request_id, patient_token`,
      [patientId, bloodType, pincode, finalLat, finalLon, patientToken, deadline]
    );
    
    const requestId = rows[0].request_id;
    
    const { rows: hospitals } = await client.query(
      'SELECT hospital_id, hospital_name, latitude, longitude FROM hospitals WHERE latitude IS NOT NULL AND longitude IS NOT NULL'
    );
    
    const alertPromises = [];
    let hospitalsNotified = 0;
    
    for (const hospital of hospitals) {
      const distance = calculateDistance(
        finalLat, finalLon, 
        hospital.latitude, hospital.longitude
      );
      
      if (distance <= 10) {
        hospitalsNotified++;
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
    
    const escalationTimeout = setTimeout(() => {
      checkAndEscalate(requestId);
    }, 10 * 60 * 1000 + 1000);
    
    activeRequests.set(requestId, escalationTimeout);
    
    console.log(`✅ SOS sent to ${hospitalsNotified} hospitals for request ${requestId} (location source: ${locationSource})`);
    
    res.status(201).json({ 
      success: true, 
      message: `SOS Alert sent to ${hospitalsNotified} nearby hospitals!`, 
      requestId, 
      patient_token: rows[0].patient_token,
      location_source: locationSource
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Error in request-blood:', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  } finally {
    client.release();
  }
});

app.get('/api/server/request-status/:requestId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT br.*, h.hospital_name, h.phone_number as hospital_phone, h.pincode as hospital_pincode, h.address as hospital_address,
       u.full_name as patient_name, u.phone_number as patient_phone_number
       FROM blood_requests br 
       LEFT JOIN hospitals h ON br.accepted_by_hospital_id = h.hospital_id 
       LEFT JOIN users u ON br.patient_id = u.user_id
       WHERE br.request_id = $1`,
      [req.params.requestId]
    );
    
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Request not found.' });
    }
    
    const request = rows[0];
    
    const response = {
      success: true,
      status: request.status,
      patient_token: request.patient_token,
      blood_type_needed: request.blood_type_needed,
      created_at: request.created_at,
      patient_name: request.patient_name,
      patient_phone: request.patient_phone_number
    };
    
    if (request.status === 'accepted' && request.accepted_by_hospital_id) {
      response.hospital = {
        name: request.hospital_name,
        phone: request.hospital_phone,
        pincode: request.hospital_pincode,
        address: request.hospital_address
      };
    }
    
    res.json(response);
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.get('/api/server/requests/history/:patientId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT 
        br.request_id,
        br.blood_type_needed,
        br.status,
        br.patient_token,
        br.created_at,
        h.hospital_name
       FROM blood_requests br
       LEFT JOIN hospitals h ON br.accepted_by_hospital_id = h.hospital_id
       WHERE br.patient_id = $1
       ORDER BY br.created_at DESC
       LIMIT 20`,
      [req.params.patientId]
    );
    
    res.json({ success: true, history: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ============================================================================
// HOSPITAL AUTHENTICATION & MANAGEMENT
// ============================================================================

app.post('/api/server/hospital-login', async (req, res) => {
  const { hospitalId, password } = req.body;
  
  if (!hospitalId || !password) {
    return res.status(400).json({ success: false, message: 'Hospital ID and password required.' });
  }
  
  try {
    const { rows } = await pool.query(
      'SELECT * FROM hospitals WHERE hospital_id = $1',
      [hospitalId]
    );
    
    if (!rows.length) {
      return res.status(401).json({ success: false, message: 'Hospital not found.' });
    }
    
    const hospital = rows[0];
    
    if (hospital.password_hash !== password) {
      return res.status(401).json({ success: false, message: 'Invalid password.' });
    }
    
    res.json({ 
      success: true, 
      message: 'Login successful!', 
      hospital: {
        hospital_id: hospital.hospital_id,
        hospital_name: hospital.hospital_name,
        phone_number: hospital.phone_number,
        pincode: hospital.pincode,
        address: hospital.address,
        blood_inventory: hospital.blood_inventory
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/server/hospital-register', async (req, res) => {
  const { hospitalName, address, pincode, phoneNumber, password, latitude, longitude } = req.body;
  
  if (!hospitalName || !address || !pincode || !phoneNumber || !password) {
    return res.status(400).json({ success: false, message: 'All fields required.' });
  }
  
  try {
    const { rows: countRows } = await pool.query('SELECT COUNT(*) as count FROM hospitals');
    const count = parseInt(countRows[0].count) + 1;
    const hospitalId = 'HOS' + String(count).padStart(3, '0');
    
    let finalLat = latitude;
    let finalLon = longitude;
    
    if (!latitude || !longitude) {
      const coords = await getCoordsFromPincode(pincode);
      finalLat = coords.lat;
      finalLon = coords.lon;
    }
    
    const { rows } = await pool.query(
      `INSERT INTO hospitals (hospital_id, hospital_name, address, pincode, phone_number, password_hash, latitude, longitude, blood_inventory)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [hospitalId, hospitalName, address, pincode, phoneNumber, password, finalLat, finalLon, '{}']
    );
    
    res.status(201).json({ 
      success: true, 
      message: 'Hospital registered successfully!',
      hospital: {
        hospital_id: rows[0].hospital_id,
        hospital_name: rows[0].hospital_name
      }
    });
  } catch (e) {
    console.error(e);
    if (e.code === '23505') {
      return res.status(409).json({ success: false, message: 'Phone number already registered.' });
    }
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  }
});

app.get('/api/server/sos-alerts/:hospitalId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT 
        br.request_id,
        br.blood_type_needed,
        br.urgency,
        br.deadline,
        br.created_at,
        br.pincode as patient_pincode,
        als.distance_km,
        als.status as alert_status,
        u.full_name as patient_name,
        u.phone_number as patient_phone
       FROM alert_status als
       JOIN blood_requests br ON als.request_id = br.request_id
       LEFT JOIN users u ON br.patient_id = u.user_id
       WHERE als.hospital_id = $1 
         AND als.status IN ('sent', 'pending')
         AND br.status = 'pending'
       ORDER BY br.created_at DESC`,
      [req.params.hospitalId]
    );
    
    res.json({ success: true, alerts: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/server/hospital-response', async (req, res) => {
  const { requestId, hospitalId, status } = req.body;
  
  if (!requestId || !hospitalId || !status) {
    return res.status(400).json({ success: false, message: 'Missing required fields.' });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const reqCheck = await client.query(
      "SELECT status FROM blood_requests WHERE request_id = $1 FOR UPDATE",
      [requestId]
    );
    
    if (!reqCheck.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Request not found.' });
    }
    
    if (reqCheck.rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ 
        success: false, 
        message: 'Request already processed by another hospital.' 
      });
    }
    
    if (status === 'Accepted' || status === 'accepted') {
      await client.query(
        "UPDATE blood_requests SET status = 'accepted', accepted_by_hospital_id = $1 WHERE request_id = $2",
        [hospitalId, requestId]
      );
      
      await client.query(
        "UPDATE alert_status SET status = 'accepted', response_at = NOW() WHERE request_id = $1 AND hospital_id = $2",
        [requestId, hospitalId]
      );
      
      if (activeRequests.has(requestId)) {
        clearTimeout(activeRequests.get(requestId));
        activeRequests.delete(requestId);
      }
      
      await client.query('COMMIT');
      
      console.log(`✅ Hospital ${hospitalId} accepted request ${requestId}`);
      
      res.json({ 
        success: true, 
        message: 'Request accepted! Patient will be notified.' 
      });
    } else {
      await client.query(
        "UPDATE alert_status SET status = 'rejected', response_at = NOW() WHERE request_id = $1 AND hospital_id = $2",
        [requestId, hospitalId]
      );
      
      await client.query('COMMIT');
      
      console.log(`❌ Hospital ${hospitalId} rejected request ${requestId}`);
      
      res.json({ 
        success: true, 
        message: 'Request rejected.' 
      });
    }
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  } finally {
    client.release();
  }
});

app.post('/api/server/update-inventory', async (req, res) => {
  const { hospitalId, stock } = req.body;
  
  if (!hospitalId || !stock) {
    return res.status(400).json({ success: false, message: 'Missing required fields.' });
  }
  
  try {
    await pool.query(
      'UPDATE hospitals SET blood_inventory = $1 WHERE hospital_id = $2',
      [JSON.stringify(stock), hospitalId]
    );
    
    res.json({ 
      success: true, 
      message: 'Inventory updated successfully!' 
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/server/verify-token', async (req, res) => {
  const { token } = req.body;
  
  if (!token) {
    return res.status(400).json({ success: false, message: 'Token required.' });
  }
  
  try {
    const patientCheck = await pool.query(
      `SELECT 
        br.*, 
        u.full_name as patient_name, 
        u.phone_number as patient_phone,
        u.blood_type as patient_blood_type,
        u.pincode as patient_pincode,
        h.hospital_name,
        h.address as hospital_address,
        h.pincode as hospital_pincode
       FROM blood_requests br
       JOIN users u ON br.patient_id = u.user_id
       LEFT JOIN hospitals h ON br.accepted_by_hospital_id = h.hospital_id
       WHERE br.patient_token = $1`,
      [token]
    );
    
    if (patientCheck.rows.length) {
      const data = patientCheck.rows[0];
      return res.json({ 
        valid: true, 
        type: 'patient',
        name: data.patient_name,
        phone: data.patient_phone,
        bloodType: data.blood_type_needed,
        status: data.status
      });
    }
    
    const donorCheck = await pool.query(
      `SELECT 
        dc.*,
        u.full_name as donor_name,
        u.phone_number as donor_phone,
        u.blood_type as donor_blood_type
       FROM donation_commitments dc
       JOIN users u ON dc.donor_id = u.user_id
       WHERE dc.donor_token = $1`,
      [token]
    );
    
    if (donorCheck.rows.length) {
      const data = donorCheck.rows[0];
      return res.json({ 
        valid: true, 
        type: 'donor',
        name: data.donor_name,
        phone: data.donor_phone,
        bloodType: data.donor_blood_type,
        status: data.status
      });
    }
    
    res.json({ valid: false, message: 'Invalid token.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ============================================================================
// DONOR AUTHENTICATION & MANAGEMENT
// ============================================================================

app.post('/api/server/donor/send-otp', async (req, res) => {
  const { phoneNumber } = req.body;
  
  if (!phoneNumber) {
    return res.status(400).json({ success: false, message: 'Phone number required.' });
  }
  
  try {
    const otp = generateOTP();
    otpStore[phoneNumber] = { 
      otp, 
      expiry: Date.now() + 300000 
    };
    
    console.log(`📱 Donor OTP for ${phoneNumber}: ${otp}`);
    
    res.json({ 
      success: true, 
      otp, 
      message: `OTP generated: ${otp}` 
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/server/donor-login', async (req, res) => {
  const { phoneNumber, fullName, bloodType, pincode, otp } = req.body;
  
  const record = otpStore[phoneNumber];
  if (!record || record.otp !== otp || Date.now() >= record.expiry) {
    return res.status(401).json({ success: false, message: 'Invalid or expired OTP.' });
  }
  
  delete otpStore[phoneNumber];
  
  try {
    const existing = await pool.query(
      "SELECT * FROM users WHERE phone_number = $1 AND role = 'donor'",
      [phoneNumber]
    );
    
    if (existing.rows.length) {
      const { rows } = await pool.query(
        "UPDATE users SET full_name = $1, blood_type = $2, pincode = $3, last_login = NOW() WHERE phone_number = $4 AND role = 'donor' RETURNING *",
        [fullName, bloodType, pincode, phoneNumber]
      );
      return res.json({ 
        success: true, 
        message: 'Login successful!', 
        user: rows[0] 
      });
    }
    
    if (!fullName || !bloodType || !pincode) {
      return res.status(400).json({ 
        success: false, 
        message: 'All fields required for registration.' 
      });
    }
    
    const { rows } = await pool.query(
      "INSERT INTO users (full_name, phone_number, role, blood_type, pincode) VALUES ($1, $2, 'donor', $3, $4) RETURNING *",
      [fullName, phoneNumber, bloodType, pincode]
    );
    
    res.status(201).json({ 
      success: true, 
      message: 'Registration successful!', 
      user: rows[0] 
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Database error.' });
  }
});

app.get('/api/server/donor/sos-alerts/:donorId', async (req, res) => {
  try {
    const donorResult = await pool.query(
      'SELECT blood_type, latitude, longitude FROM users WHERE user_id = $1',
      [req.params.donorId]
    );
    
    if (!donorResult.rows.length) {
      return res.status(404).json({ success: false, message: 'Donor not found.' });
    }
    
    const donor = donorResult.rows[0];
    
    const { rows } = await pool.query(
      `SELECT 
        br.request_id,
        br.blood_type_needed,
        br.latitude,
        br.longitude,
        br.created_at,
        br.deadline,
        u.full_name as patient_name
       FROM blood_requests br
       LEFT JOIN users u ON br.patient_id = u.user_id
       WHERE br.status = 'escalated' 
         AND br.blood_type_needed = $1
       ORDER BY br.created_at DESC`,
      [donor.blood_type]
    );
    
    const alertsWithDistance = rows.map(alert => ({
      ...alert,
      distance_km: donor.latitude && donor.longitude && alert.latitude && alert.longitude
        ? calculateDistance(donor.latitude, donor.longitude, alert.latitude, alert.longitude).toFixed(2)
        : null
    }));
    
    res.json({ success: true, alerts: alertsWithDistance });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/server/donor/accept-sos', async (req, res) => {
  const { donorId, requestId, donorLatitude, donorLongitude } = req.body;
  
  if (!donorId || !requestId) {
    return res.status(400).json({ success: false, message: 'Missing required fields.' });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const reqCheck = await client.query(
      "SELECT status FROM blood_requests WHERE request_id = $1 FOR UPDATE",
      [requestId]
    );
    
    if (!reqCheck.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Request not found.' });
    }
    
    if (reqCheck.rows[0].status !== 'escalated') {
      await client.query('ROLLBACK');
      return res.status(409).json({ 
        success: false, 
        message: 'Request no longer available.' 
      });
    }
    
    const donorToken = await generateUniqueDonorToken(client);
    
    const { rows: hospitals } = await client.query(
      'SELECT hospital_id, hospital_name, address, pincode, latitude, longitude FROM hospitals ORDER BY hospital_id LIMIT 1'
    );
    
    const hospital = hospitals[0];
    
    await client.query(
      `INSERT INTO donation_commitments 
       (request_id, donor_id, donor_token, hospital_id, donor_lat_on_accept, donor_lon_on_accept, status) 
       VALUES ($1, $2, $3, $4, $5, $6, 'committed')`,
      [requestId, donorId, donorToken, hospital.hospital_id, donorLatitude, donorLongitude]
    );
    
    await client.query(
      "UPDATE blood_requests SET status = 'donor_assigned', assigned_hospital_id = $1 WHERE request_id = $2",
      [hospital.hospital_id, requestId]
    );
    
    await client.query('COMMIT');
    
    console.log(`✅ Donor ${donorId} accepted request ${requestId}`);
    
    res.json({ 
      success: true, 
      message: 'Request accepted!',
      donor_token: donorToken,
      hospital: {
        name: hospital.hospital_name,
        address: hospital.address,
        pincode: hospital.pincode
      }
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  } finally {
    client.release();
  }
});

app.get('/api/server/donor/commitments/:donorId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT 
        dc.commitment_id,
        dc.donor_token,
        dc.status,
        dc.created_at,
        br.blood_type_needed,
        h.hospital_name,
        h.address,
        h.pincode
       FROM donation_commitments dc
       JOIN blood_requests br ON dc.request_id = br.request_id
       LEFT JOIN hospitals h ON dc.hospital_id = h.hospital_id
       WHERE dc.donor_id = $1
       ORDER BY dc.created_at DESC
       LIMIT 20`,
      [req.params.donorId]
    );
    
    res.json({ success: true, commitments: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ============================================================================
// VOLUNTEER AUTHENTICATION & MANAGEMENT - FIXED
// ============================================================================

app.post('/api/server/volunteer/send-otp', async (req, res) => {
  const { phoneNumber } = req.body;
  
  if (!phoneNumber) {
    return res.status(400).json({ success: false, message: 'Phone number required.' });
  }
  
  try {
    const otp = generateOTP();
    otpStore[phoneNumber] = { 
      otp, 
      expiry: Date.now() + 300000 
    };
    
    console.log(`📱 Volunteer OTP for ${phoneNumber}: ${otp}`);
    
    res.json({ 
      success: true, 
      otp, 
      message: `OTP generated: ${otp}` 
    });
  } catch (e) {
    console.error('Volunteer OTP Error:', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/server/volunteer-login', async (req, res) => {
  const { phoneNumber, fullName, ngoName, registrationId, type, otp } = req.body;
  
  console.log('🔵 Volunteer login attempt:', { phoneNumber, type });
  
  // Validate OTP
  const record = otpStore[phoneNumber];
  if (!record || record.otp !== otp || Date.now() >= record.expiry) {
    return res.status(401).json({ success: false, message: 'Invalid or expired OTP.' });
  }
  
  delete otpStore[phoneNumber];
  
  try {
    // Check if user exists
    const { rows } = await pool.query(
      "SELECT user_id, full_name, phone_number, role, registration_id FROM users WHERE phone_number = $1 AND (role = 'volunteer' OR role = 'ngo')",
      [phoneNumber]
    );
    
    if (rows.length) {
      // Existing user - update their information
      const user = rows[0];
      const updateName = (type === 'volunteer') ? fullName : ngoName;
      const updateRegId = (type === 'ngo') ? registrationId : null;
      
      await pool.query(
        "UPDATE users SET full_name = $1, role = $2, registration_id = $3, last_login = NOW() WHERE user_id = $4",
        [updateName, type, updateRegId, user.user_id]
      );
      
      console.log(`✅ Existing volunteer logged in: ${user.user_id}`);
      
      return res.json({ 
        success: true, 
        message: 'Login successful!', 
        user: {
          user_id: user.user_id,
          full_name: updateName,
          phone_number: phoneNumber,
          role: type,
          registration_id: updateRegId
        }
      });
    }
    
    // New user - create account
    const name = (type === 'volunteer') ? fullName : ngoName;
    const regId = (type === 'ngo') ? registrationId : null;
    
    const newUser = await pool.query(
      `INSERT INTO users (full_name, phone_number, role, registration_id, created_at, last_login) 
       VALUES ($1, $2, $3, $4, NOW(), NOW()) 
       RETURNING user_id, full_name, phone_number, role, registration_id`,
      [name, phoneNumber, type, regId]
    );
    
    console.log(`✅ New volunteer registered: ${newUser.rows[0].user_id}`);
    
    res.status(201).json({ 
      success: true, 
      message: 'Registration successful!', 
      user: newUser.rows[0] 
    });
  } catch (e) {
    console.error('❌ Volunteer login error:', e);
    res.status(500).json({ 
      success: false, 
      message: 'Database error: ' + e.message 
    });
  }
});

// ============================================================================
// ADMIN AUTHENTICATION - NEW WITH ACCESS CODE
// ============================================================================

app.post('/api/server/admin-register', async (req, res) => {
  const { username, email, password, accessCode } = req.body;
  
  console.log('🔐 Admin registration attempt:', { username, email, accessCode });
  
  // Validate required fields
  if (!username || !email || !password || !accessCode) {
    return res.status(400).json({ 
      success: false, 
      message: 'All fields are required.' 
    });
  }
  
  // Validate access code
  if (accessCode !== ADMIN_ACCESS_CODE) {
    console.log('❌ Invalid access code:', accessCode);
    return res.status(403).json({ 
      success: false, 
      message: 'Invalid access code. Admin registration denied.' 
    });
  }
  
  try {
    // Check if admin already exists
    const existing = await pool.query(
      "SELECT user_id FROM users WHERE (full_name = $1 OR phone_number = $2) AND role = 'admin'",
      [username, email]
    );
    
    if (existing.rows.length > 0) {
      return res.status(409).json({ 
        success: false, 
        message: 'Admin with this username or email already exists.' 
      });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Create admin user
    const { rows } = await pool.query(
      `INSERT INTO users (full_name, phone_number, role, password_hash, created_at, last_login) 
       VALUES ($1, $2, 'admin', $3, NOW(), NOW()) 
       RETURNING user_id, full_name, phone_number, role`,
      [username, email, hashedPassword]
    );
    
    console.log(`✅ Admin registered successfully: ${rows[0].user_id}`);
    
    res.status(201).json({ 
      success: true, 
      message: 'Admin registered successfully!',
      user: rows[0]
    });
  } catch (e) {
    console.error('❌ Admin registration error:', e);
    res.status(500).json({ 
      success: false, 
      message: 'Database error: ' + e.message 
    });
  }
});

app.post('/api/server/admin-login', async (req, res) => {
  const { username, password } = req.body;
  
  console.log('🔐 Admin login attempt:', { username });
  
  if (!username || !password) {
    return res.status(400).json({ 
      success: false, 
      message: 'Username and password required.' 
    });
  }
  
  try {
    // Find admin by username (stored in full_name) or email (stored in phone_number)
    const { rows } = await pool.query(
      "SELECT user_id, full_name, phone_number, password_hash FROM users WHERE (full_name = $1 OR phone_number = $1) AND role = 'admin'",
      [username]
    );
    
    if (rows.length === 0) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid username or password.' 
      });
    }
    
    const admin = rows[0];
    
    // Verify password
    const isValidPassword = await bcrypt.compare(password, admin.password_hash);
    
    if (!isValidPassword) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid username or password.' 
      });
    }
    
    // Update last login
    await pool.query(
      "UPDATE users SET last_login = NOW() WHERE user_id = $1",
      [admin.user_id]
    );
    
    console.log(`✅ Admin logged in successfully: ${admin.user_id}`);
    
    res.json({ 
      success: true, 
      message: 'Login successful!',
      user: {
        user_id: admin.user_id,
        username: admin.full_name,
        email: admin.phone_number,
        role: 'admin'
      }
    });
  } catch (e) {
    console.error('❌ Admin login error:', e);
    res.status(500).json({ 
      success: false, 
      message: 'Database error: ' + e.message 
    });
  }
});

// ============================================================================
// SERVER START
// ============================================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LifeLink Server running on port ${PORT}`);
  console.log(`🔐 Admin Access Code: ${ADMIN_ACCESS_CODE}`);
});

module.exports = app;