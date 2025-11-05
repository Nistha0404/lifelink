const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

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

// ADMIN ACCESS CODE - Change this in production!
const ADMIN_ACCESS_CODE = process.env.ADMIN_ACCESS_CODE || '1900';

// In-memory OTP storage (use Redis in production)
const otpStore = {};

// In-memory active requests tracking for escalation
const activeRequests = new Map();

// In-memory session storage (use Redis in production)
const adminSessions = new Map();

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

function generateSecureToken() {
  return crypto.randomBytes(32).toString('hex');
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
// ADMIN AUTHENTICATION MIDDLEWARE
// ============================================================================

function authenticateAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token || !adminSessions.has(token)) {
    return res.status(401).json({ 
      success: false, 
      message: 'Unauthorized. Please login.' 
    });
  }
  
  const session = adminSessions.get(token);
  
  // Check if session has expired (24 hours)
  if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
    adminSessions.delete(token);
    return res.status(401).json({ 
      success: false, 
      message: 'Session expired. Please login again.' 
    });
  }
  
  req.adminId = session.adminId;
  next();
}

// ============================================================================
// ADMIN AUTHENTICATION - WITH ACCESS CODE (NO BCRYPT)
// ============================================================================

app.post('/api/server/register/admin', async (req, res) => {
  const { fullName, pincode, phoneNumber, password, accessCode } = req.body;
  
  console.log('🔐 Admin registration attempt:', { fullName, phoneNumber, accessCode: accessCode ? '***' : 'missing' });
  
  // Validate required fields
  if (!fullName || !pincode || !phoneNumber || !password || !accessCode) {
    return res.status(400).json({ 
      success: false, 
      message: 'All fields are required.' 
    });
  }
  
  // Validate phone number format
  if (!/^\d{10}$/.test(phoneNumber)) {
    return res.status(400).json({ 
      success: false, 
      message: 'Invalid phone number format. Must be 10 digits.' 
    });
  }
  
  // Validate pincode format
  if (!/^\d{6}$/.test(pincode)) {
    return res.status(400).json({ 
      success: false, 
      message: 'Invalid pincode format. Must be 6 digits.' 
    });
  }
  
  // Validate password length
  if (password.length < 6) {
    return res.status(400).json({ 
      success: false, 
      message: 'Password must be at least 6 characters long.' 
    });
  }
  
  // CRITICAL: Validate access code
  if (accessCode !== ADMIN_ACCESS_CODE) {
    console.log('❌ Invalid access code attempt:', accessCode);
    return res.status(403).json({ 
      success: false, 
      message: 'Invalid access code. Admin registration denied.' 
    });
  }
  
  try {
    // Check if admin with this phone number already exists
    const existing = await pool.query(
      "SELECT user_id FROM users WHERE phone_number = $1 AND role = 'admin'",
      [phoneNumber]
    );
    
    if (existing.rows.length > 0) {
      return res.status(409).json({ 
        success: false, 
        message: 'An admin with this phone number already exists.' 
      });
    }
    
    // Store password as plain text in password_hash column
    // ⚠️ WARNING: This is NOT secure for production use!
    
    // Create admin user with plain text password
    const { rows } = await pool.query(
      `INSERT INTO users (full_name, phone_number, pincode, role, password_hash, created_at, last_login) 
       VALUES ($1, $2, $3, 'admin', $4, NOW(), NOW()) 
       RETURNING user_id, full_name, phone_number, pincode, role`,
      [fullName, phoneNumber, pincode, password]
    );
    
    console.log(`✅ Admin registered successfully: ${rows[0].user_id}`);
    
    res.status(201).json({ 
      success: true, 
      message: 'Admin registered successfully!',
      user: {
        user_id: rows[0].user_id,
        fullName: rows[0].full_name,
        phoneNumber: rows[0].phone_number,
        pincode: rows[0].pincode,
        role: rows[0].role
      }
    });
  } catch (e) {
    console.error('❌ Admin registration error:', e);
    
    // Handle unique constraint violation
    if (e.code === '23505') {
      return res.status(409).json({ 
        success: false, 
        message: 'An admin with this phone number already exists.' 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: 'Database error. Please try again.' 
    });
  }
});

app.post('/api/server/login/admin', async (req, res) => {
  const { phoneNumber, password } = req.body;
  
  console.log('🔐 Admin login attempt:', { phoneNumber });
  
  // Validate required fields
  if (!phoneNumber || !password) {
    return res.status(400).json({ 
      success: false, 
      message: 'Phone number and password are required.' 
    });
  }
  
  // Validate phone number format
  if (!/^\d{10}$/.test(phoneNumber)) {
    return res.status(400).json({ 
      success: false, 
      message: 'Invalid phone number format.' 
    });
  }
  
  try {
    // Find admin by phone number
    const { rows } = await pool.query(
      "SELECT user_id, full_name, phone_number, pincode, password_hash FROM users WHERE phone_number = $1 AND role = 'admin'",
      [phoneNumber]
    );
    
    if (rows.length === 0) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid phone number or password.' 
      });
    }
    
    const admin = rows[0];
    
    // Compare plain text passwords directly
    // ⚠️ WARNING: This is NOT secure for production use!
    if (password !== admin.password_hash) {
      console.log('❌ Invalid password for admin:', phoneNumber);
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid phone number or password.' 
      });
    }
    
    // Generate secure session token
    const token = generateSecureToken();
    
    // Store session
    adminSessions.set(token, {
      adminId: admin.user_id,
      phoneNumber: admin.phone_number,
      createdAt: Date.now()
    });
    
    // Update last login timestamp
    await pool.query(
      "UPDATE users SET last_login = NOW() WHERE user_id = $1",
      [admin.user_id]
    );
    
    console.log(`✅ Admin logged in successfully: ${admin.user_id}`);
    
    res.json({ 
      success: true, 
      message: 'Login successful!',
      token: token,
      user: {
        user_id: admin.user_id,
        fullName: admin.full_name,
        phoneNumber: admin.phone_number,
        pincode: admin.pincode,
        role: 'admin'
      }
    });
  } catch (e) {
    console.error('❌ Admin login error:', e);
    res.status(500).json({ 
      success: false, 
      message: 'Database error. Please try again.' 
    });
  }
});

// Admin logout endpoint
app.post('/api/server/logout/admin', authenticateAdmin, async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (token) {
    adminSessions.delete(token);
  }
  
  res.json({ 
    success: true, 
    message: 'Logged out successfully.' 
  });
});

// Verify admin session endpoint
app.get('/api/server/verify/admin', authenticateAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT user_id, full_name, phone_number, pincode, role FROM users WHERE user_id = $1 AND role = 'admin'",
      [req.adminId]
    );
    
    if (rows.length === 0) {
      return res.status(401).json({ 
        success: false, 
        message: 'Admin not found.' 
      });
    }
    
    res.json({ 
      success: true, 
      user: {
        user_id: rows[0].user_id,
        fullName: rows[0].full_name,
        phoneNumber: rows[0].phone_number,
        pincode: rows[0].pincode,
        role: rows[0].role
      }
    });
  } catch (e) {
    console.error('❌ Admin verification error:', e);
    res.status(500).json({ 
      success: false, 
      message: 'Server error.' 
    });
  }
});

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
// PATIENT SOS - CORE WORKFLOW (keeping your original code)
// ============================================================================

app.post('/api/server/request-blood', async (req, res) => {
  const { patientId, bloodType, pincode, latitude, longitude } = req.body;
  
  if (!patientId || !bloodType || !pincode) {
    return res.status(400).json({ 
      success: false, 
      message: 'Patient ID, blood type, and pincode are required.' 
    });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    let coords = { lat: latitude, lon: longitude };
    if (!latitude || !longitude) {
      coords = await getCoordsFromPincode(pincode);
    }
    
    const patientToken = await generateUniquePatientToken(client);
    
    const { rows } = await client.query(
      `INSERT INTO blood_requests 
       (patient_id, blood_type_needed, status, patient_token, latitude, longitude, pincode, created_at) 
       VALUES ($1, $2, 'pending', $3, $4, $5, $6, NOW()) 
       RETURNING *`,
      [patientId, bloodType, patientToken, coords.lat, coords.lon, pincode]
    );
    
    const requestId = rows[0].request_id;
    
    const escalationTime = 10 * 60 * 1000;
    setTimeout(() => checkAndEscalate(requestId), escalationTime);
    
    await client.query('COMMIT');
    
    console.log(`✅ Blood request created: ${requestId}`);
    
    res.status(201).json({ 
      success: true, 
      message: 'Blood request created successfully.',
      request: rows[0]
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Request blood error:', e);
    res.status(500).json({ 
      success: false, 
      message: 'Database error.' 
    });
  } finally {
    client.release();
  }
});

app.get('/api/server/patient/:patientId/requests', async (req, res) => {
  const { patientId } = req.params;
  
  try {
    const { rows } = await pool.query(
      `SELECT * FROM blood_requests 
       WHERE patient_id = $1 
       ORDER BY created_at DESC 
       LIMIT 10`,
      [patientId]
    );
    
    res.json({ success: true, requests: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ============================================================================
// VOLUNTEER AUTHENTICATION & MANAGEMENT (keeping your original code)
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
// PROTECTED ADMIN ROUTES
// ============================================================================

app.get('/api/server/admin/users', authenticateAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT user_id, full_name, phone_number, role, created_at, last_login FROM users ORDER BY created_at DESC'
    );
    
    res.json({ success: true, users: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.get('/api/server/admin/requests', authenticateAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT br.*, u.full_name as patient_name, u.phone_number as patient_phone
       FROM blood_requests br
       LEFT JOIN users u ON br.patient_id = u.user_id
       ORDER BY br.created_at DESC
       LIMIT 100`
    );
    
    res.json({ success: true, requests: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ============================================================================
// SERVER START
// ============================================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LifeLink Server running on port ${PORT}`);
  console.log(`🔐 Admin Access Code: ${ADMIN_ACCESS_CODE}`);
  console.log(`⚠️  Change the access code in production!`);
  console.log(`⚠️  WARNING: Passwords stored in plain text - NOT secure!`);
});

module.exports = app;