const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');

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
const OPENCAGE_API_KEY = process.env.OPENCAGE_API_KEY;

// In-memory OTP storage (use Redis in production)
const otpStore = {};

// In-memory active requests tracking for escalation
const activeRequests = new Map();

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Calculate distance between two coordinates using Haversine formula
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return Infinity;
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) ** 2 + 
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
            Math.sin(dLon/2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Generate 4-digit token
 */
function generate4DigitToken() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

/**
 * Generate OTP (4-digit)
 */
function generateOTP() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

/**
 * Generate unique patient token
 */
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

/**
 * Generate unique donor token
 */
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

/**
 * Escalate request to donors after hospital timeout
 */
async function checkAndEscalate(requestId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Check if request is still pending
    const reqRes = await client.query(
      "SELECT status, blood_type_needed, latitude, longitude FROM blood_requests WHERE request_id = $1 FOR UPDATE", 
      [requestId]
    );
    
    if (!reqRes.rows.length || reqRes.rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return;
    }

    const { blood_type_needed, latitude, longitude } = reqRes.rows[0];
    
    // Check if any hospital has already responded
    const sentAlerts = await client.query(
      "SELECT 1 FROM alert_status WHERE request_id = $1 AND status = 'accepted'", 
      [requestId]
    );
    
    if (sentAlerts.rows.length === 0) {
      console.log(`🚨 Escalating request ${requestId} to donors...`);
      
      // Update request status to escalated
      await client.query(
        "UPDATE blood_requests SET status = 'escalated' WHERE request_id = $1", 
        [requestId]
      );
      
      // Get matching donors
      const { rows: donors } = await client.query(
        "SELECT user_id, phone_number, full_name, latitude, longitude FROM users WHERE role = 'donor' AND blood_type = $1", 
        [blood_type_needed]
      );
      
      console.log(`📢 Notified ${donors.length} donors for request ${requestId}`);
      
      // In production, send actual SMS/push notifications here
      // For now, donors will see alerts when they check their dashboard
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

/**
 * Send OTP to patient phone (mock - returns OTP in response for popup display)
 */
app.post('/api/server/send-otp', async (req, res) => {
  const { phoneNumber } = req.body;
  
  if (!phoneNumber) {
    return res.status(400).json({ success: false, message: 'Phone number required.' });
  }
  
  try {
    const otp = generateOTP();
    otpStore[phoneNumber] = { 
      otp, 
      expiry: Date.now() + 300000 // 5 minutes
    };
    
    console.log(`📱 Patient OTP for ${phoneNumber}: ${otp}`);
    
    // Return OTP in response for popup display (in production, send via SMS)
    res.json({ 
      success: true, 
      otp, // Include OTP for frontend popup
      message: `OTP generated: ${otp}` 
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/**
 * Patient login/register with OTP verification
 */
app.post('/api/server/patient-login', async (req, res) => {
  const { phoneNumber, fullName, pincode, otp } = req.body;
  
  // Verify OTP
  const record = otpStore[phoneNumber];
  if (!record || record.otp !== otp || Date.now() >= record.expiry) {
    return res.status(401).json({ success: false, message: 'Invalid or expired OTP.' });
  }
  
  delete otpStore[phoneNumber];
  
  try {
    // Check if user exists
    const existing = await pool.query(
      "SELECT * FROM users WHERE phone_number = $1 AND role = 'patient'", 
      [phoneNumber]
    );
    
    if (existing.rows.length) {
      // Update existing user
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
    
    // Create new user
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

/**
 * Patient requests blood - sends SOS to nearby hospitals
 */
app.post('/api/server/request-blood', async (req, res) => {
  const { patientId, bloodType, pincode, latitude, longitude } = req.body;
  
  console.log('🚨 Received SOS Request:', { patientId, bloodType, pincode, latitude, longitude });
  
  if (!patientId || !bloodType) {
    return res.status(400).json({ success: false, message: 'Missing required fields.' });
  }
  
  if (!latitude || !longitude) {
    return res.status(400).json({ success: false, message: 'Precise location is required.' });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Generate unique patient token
    const patientToken = await generateUniquePatientToken(client);
    
    // Set 10-minute deadline
    const deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    
    // Insert blood request
    const { rows } = await client.query(
      `INSERT INTO blood_requests 
       (patient_id, blood_type_needed, pincode, latitude, longitude, status, patient_token, deadline) 
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7) 
       RETURNING request_id, patient_token`,
      [patientId, bloodType, pincode, latitude, longitude, patientToken, deadline]
    );
    
    const requestId = rows[0].request_id;
    
    // Find nearby hospitals (within 10km)
    const { rows: hospitals } = await client.query(
      'SELECT hospital_id, hospital_name, latitude, longitude FROM hospitals WHERE latitude IS NOT NULL AND longitude IS NOT NULL'
    );
    
    const alertPromises = [];
    let hospitalsNotified = 0;
    
    for (const hospital of hospitals) {
      const distance = calculateDistance(
        latitude, longitude, 
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
    
    // Schedule escalation after 10 minutes
    const escalationTimeout = setTimeout(() => {
      checkAndEscalate(requestId);
    }, 10 * 60 * 1000 + 1000);
    
    // Store timeout reference for potential cancellation
    activeRequests.set(requestId, escalationTimeout);
    
    console.log(`✅ SOS sent to ${hospitalsNotified} hospitals for request ${requestId}`);
    
    res.status(201).json({ 
      success: true, 
      message: `SOS Alert sent to ${hospitalsNotified} nearby hospitals!`, 
      requestId, 
      patient_token: rows[0].patient_token 
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Error in request-blood:', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  } finally {
    client.release();
  }
});

/**
 * Get patient request status
 */
app.get('/api/server/request-status/:requestId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT br.*, h.hospital_name, h.phone_number as hospital_phone, h.pincode as hospital_pincode, h.address as hospital_address
       FROM blood_requests br 
       LEFT JOIN hospitals h ON br.accepted_by_hospital_id = h.hospital_id 
       WHERE br.request_id = $1`,
      [req.params.requestId]
    );
    
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Request not found.' });
    }
    
    const request = rows[0];
    
    // Format response based on status
    const response = {
      success: true,
      status: request.status,
      patient_token: request.patient_token,
      blood_type_needed: request.blood_type_needed,
      created_at: request.created_at
    };
    
    if (request.status === 'accepted' && request.hospital_name) {
      response.hospital = {
        name: request.hospital_name,
        address: request.hospital_address,
        pincode: request.hospital_pincode,
        phone: request.hospital_phone
      };
    }
    
    res.json(response);
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/**
 * Get patient request history
 */
app.get('/api/server/requests/history/:patientId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT br.request_id, br.blood_type_needed, br.status, br.created_at, br.patient_token, h.hospital_name
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

/**
 * Hospital login with phone and password
 */
app.post('/api/server/hospital-login', async (req, res) => {
  const { phoneNumber, password } = req.body;
  
  if (!phoneNumber || !password) {
    return res.status(400).json({ success: false, message: 'Phone number and password required.' });
  }
  
  try {
    const { rows } = await pool.query(
      'SELECT * FROM hospitals WHERE phone_number = $1',
      [phoneNumber]
    );
    
    if (!rows.length) {
      return res.status(401).json({ success: false, message: 'Hospital not found.' });
    }
    
    const hospital = rows[0];
    
    // Simple password check (in production, use bcrypt)
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
        address: hospital.address
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/**
 * Get SOS alerts for a specific hospital
 */
app.get('/api/server/sos-alerts/:hospitalId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT 
        br.request_id,
        br.blood_type_needed,
        br.urgency,
        br.deadline,
        br.created_at,
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

/**
 * Hospital responds to SOS (Accept/Reject)
 */
app.post('/api/server/hospital-response', async (req, res) => {
  const { sosId, requestId, hospitalId, status } = req.body;
  
  if (!requestId || !hospitalId || !status) {
    return res.status(400).json({ success: false, message: 'Missing required fields.' });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Check if request is still pending
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
      // Update request status
      await client.query(
        "UPDATE blood_requests SET status = 'accepted', accepted_by_hospital_id = $1 WHERE request_id = $2",
        [hospitalId, requestId]
      );
      
      // Update alert status
      await client.query(
        "UPDATE alert_status SET status = 'accepted', response_at = NOW() WHERE request_id = $1 AND hospital_id = $2",
        [requestId, hospitalId]
      );
      
      // Cancel escalation timeout
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
      // Update alert status to rejected
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

/**
 * Hospital updates inventory
 */
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
    
    res.json({ success: true, message: 'Inventory updated successfully.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/**
 * Verify token at hospital
 */
app.post('/api/server/verify-token', async (req, res) => {
  const { token } = req.body;
  
  if (!token) {
    return res.status(400).json({ success: false, message: 'Token required.' });
  }
  
  try {
    // Check patient tokens
    const patientCheck = await pool.query(
      `SELECT br.*, u.full_name, u.phone_number 
       FROM blood_requests br
       JOIN users u ON br.patient_id = u.user_id
       WHERE br.patient_token = $1`,
      [token]
    );
    
    if (patientCheck.rows.length) {
      return res.json({ 
        valid: true, 
        type: 'patient',
        name: patientCheck.rows[0].full_name,
        bloodType: patientCheck.rows[0].blood_type_needed,
        status: patientCheck.rows[0].status
      });
    }
    
    // Check donor tokens
    const donorCheck = await pool.query(
      `SELECT dc.*, u.full_name, u.blood_type
       FROM donation_commitments dc
       JOIN users u ON dc.donor_id = u.user_id
       WHERE dc.donor_token = $1`,
      [token]
    );
    
    if (donorCheck.rows.length) {
      return res.json({ 
        valid: true, 
        type: 'donor',
        name: donorCheck.rows[0].full_name,
        bloodType: donorCheck.rows[0].blood_type,
        status: donorCheck.rows[0].status
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

/**
 * Send OTP to donor
 */
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

/**
 * Donor login/register with OTP
 */
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

/**
 * Get SOS alerts for donor (escalated requests)
 */
app.get('/api/server/donor/sos-alerts/:donorId', async (req, res) => {
  try {
    // Get donor's blood type
    const donorResult = await pool.query(
      'SELECT blood_type, latitude, longitude FROM users WHERE user_id = $1',
      [req.params.donorId]
    );
    
    if (!donorResult.rows.length) {
      return res.status(404).json({ success: false, message: 'Donor not found.' });
    }
    
    const donor = donorResult.rows[0];
    
    // Get escalated requests matching donor's blood type
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
    
    // Calculate distances if donor has location
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

/**
 * Donor accepts SOS alert
 */
app.post('/api/server/donor/accept-sos', async (req, res) => {
  const { donorId, requestId, donorLatitude, donorLongitude } = req.body;
  
  if (!donorId || !requestId) {
    return res.status(400).json({ success: false, message: 'Missing required fields.' });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Check if request is still escalated
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
    
    // Generate donor token
    const donorToken = await generateUniqueDonorToken(client);
    
    // Find nearest hospital
    const { rows: hospitals } = await client.query(
      'SELECT hospital_id, hospital_name, address, pincode, latitude, longitude FROM hospitals ORDER BY hospital_id LIMIT 1'
    );
    
    const hospital = hospitals[0];
    
    // Create donation commitment
    await client.query(
      `INSERT INTO donation_commitments 
       (request_id, donor_id, donor_token, hospital_id, donor_lat_on_accept, donor_lon_on_accept, status) 
       VALUES ($1, $2, $3, $4, $5, $6, 'committed')`,
      [requestId, donorId, donorToken, hospital.hospital_id, donorLatitude, donorLongitude]
    );
    
    // Update request status
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

/**
 * Get donor's accepted commitments
 */
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
// VOLUNTEER AUTHENTICATION & MANAGEMENT
// ============================================================================

/**
 * Send OTP to volunteer/NGO
 */
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
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/**
 * Volunteer/NGO login
 */
app.post('/api/server/volunteer-login', async (req, res) => {
  const { phoneNumber, fullName, ngoName, registrationId, type, otp } = req.body;
  
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
      `INSERT INTO users (full_name, phone_number, role, registration_id) VALUES ($1, $2, $3, $4) RETURNING user_id, full_name, phone_number, role, registration_id`,
      [name, phoneNumber, type, regId]
    );
    
    res.status(201).json({ success: true, message: 'Registration successful!', user: newUser.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Database error.' });
  }
});

/**
 * Get available drives for volunteers
 */
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

/**
 * Get roles for specific drive
 */
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

/**
 * Create donation drive
 */
app.post('/api/volunteer/drive-create', async (req, res) => {
  const { organizerId, driveName, location, startDate, endDate, startTime, endTime, targetDonors, roles } = req.body;
  
  if (!organizerId || !driveName || !location || !startDate) {
    return res.status(400).json({ success: false, message: 'Missing fields.' });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { rows } = await client.query(
      `INSERT INTO donation_drives (organizer_id, drive_name, location, start_date, end_date, start_time, end_time, target_donors) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING drive_id`,
      [organizerId, driveName, location, startDate, endDate, startTime, endTime, targetDonors]
    );
    
    const driveId = rows[0].drive_id;
    
    if (roles && roles.length) {
      for (const role of roles) {
        await client.query(
          'INSERT INTO volunteer_roles (drive_id, role_name, required_volunteers) VALUES ($1, $2, $3)',
          [driveId, role.name, role.required]
        );
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

/**
 * Sign up for drive role
 */
app.post('/api/volunteer/drive-signup', async (req, res) => {
  const { volunteerId, roleId, shiftStart, shiftEnd } = req.body;
  
  if (!volunteerId || !roleId) {
    return res.status(400).json({ success: false, message: 'Missing fields.' });
  }
  
  try {
    await pool.query(
      'INSERT INTO volunteer_assignments (volunteer_id, role_id, shift_start, shift_end) VALUES ($1, $2, $3, $4)',
      [volunteerId, roleId, shiftStart, shiftEnd]
    );
    
    await pool.query(
      'UPDATE volunteer_roles SET assigned_volunteers = assigned_volunteers + 1 WHERE role_id = $1',
      [roleId]
    );
    
    res.json({ success: true, message: 'Signed up successfully!' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

/**
 * Get volunteer assignments
 */
app.get('/api/volunteer/my-assignments/:volunteerId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT va.*, vr.role_name, d.drive_name, d.location, d.start_date 
       FROM volunteer_assignments va 
       JOIN volunteer_roles vr ON va.role_id = vr.role_id 
       JOIN donation_drives d ON vr.drive_id = d.drive_id 
       WHERE va.volunteer_id = $1 
       ORDER BY d.start_date DESC`,
      [req.params.volunteerId]
    );
    res.json({ success: true, assignments: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ============================================================================
// ADMIN AUTHENTICATION
// ============================================================================

/**
 * Admin login with username and password
 */
app.post('/api/server/admin-login', async (req, res) => {
  const { username, password } = req.body;
  
  // Simple admin authentication (use proper auth in production)
  if (username === 'admin' && password === 'admin123') {
    res.json({ 
      success: true, 
      message: 'Login successful!',
      admin: { username: 'admin', role: 'admin' }
    });
  } else {
    res.status(401).json({ success: false, message: 'Invalid credentials.' });
  }
});

// ============================================================================
// AWARENESS KIT
// ============================================================================

app.post('/api/awareness/generate-material', async (req, res) => {
  const { createdBy, materialType, title } = req.body;
  
  if (!createdBy || !materialType || !title) {
    return res.status(400).json({ success: false, message: 'Missing fields.' });
  }
  
  try {
    const qrData = `https://lifelink.app/pledge?ref=${Math.random().toString(36).substr(2, 9)}`;
    const contentUrl = `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect fill="%23fff" width="400" height="600"/><text x="200" y="100" text-anchor="middle" font-size="24" font-weight="bold">${encodeURIComponent(title)}</text><text x="200" y="300" text-anchor="middle" font-size="16">Scan to Pledge</text></svg>`;
    
    const { rows } = await pool.query(
      'INSERT INTO awareness_materials (created_by, material_type, title, content_url, qr_code_data) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [createdBy, materialType, title, contentUrl, qrData]
    );
    
    res.json({ success: true, material: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/api/server/health', (req, res) => {
  res.json({ status: 'ok', message: 'LifeLink server is running!' });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

// For local development
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 LifeLink Server running on port ${PORT}`);
  });
}

// For Vercel serverless deployment
module.exports = app;