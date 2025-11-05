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
const ADMIN_ACCESS_CODE = process.env.ADMIN_ACCESS_CODE || '1900';

// In-memory storage (use Redis in production)
const otpStore = {};
const activeRequests = new Map();
const adminSessions = new Map();
const hospitalSessions = new Map(); // Hospital sessions

// Pincode to Lat/Lon mapping
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

// ============================================================================
// AUTHENTICATION MIDDLEWARE
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

function authenticateHospital(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (!token || !hospitalSessions.has(token)) {
    return res.status(401).json({ 
      success: false, 
      message: 'Unauthorized. Please login.' 
    });
  }
  
  const session = hospitalSessions.get(token);
  
  if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
    hospitalSessions.delete(token);
    return res.status(401).json({ 
      success: false, 
      message: 'Session expired. Please login again.' 
    });
  }
  
  req.hospitalId = session.hospitalId;
  next();
}

// ============================================================================
// HOSPITAL AUTHENTICATION
// ============================================================================

app.post('/api/server/register/hospital', async (req, res) => {
  const { hospitalName, phoneNumber, password, address, pincode, email } = req.body;
  
  console.log('🏥 Hospital registration attempt:', { hospitalName, phoneNumber });
  
  if (!hospitalName || !phoneNumber || !password || !address || !pincode) {
    return res.status(400).json({ 
      success: false, 
      message: 'All fields are required.' 
    });
  }
  
  if (!/^\d{10}$/.test(phoneNumber)) {
    return res.status(400).json({ 
      success: false, 
      message: 'Invalid phone number format. Must be 10 digits.' 
    });
  }
  
  if (!/^\d{6}$/.test(pincode)) {
    return res.status(400).json({ 
      success: false, 
      message: 'Invalid pincode format. Must be 6 digits.' 
    });
  }
  
  if (password.length < 6) {
    return res.status(400).json({ 
      success: false, 
      message: 'Password must be at least 6 characters long.' 
    });
  }
  
  try {
    const existing = await pool.query(
      "SELECT hospital_id FROM hospitals WHERE phone_number = $1",
      [phoneNumber]
    );
    
    if (existing.rows.length > 0) {
      return res.status(409).json({ 
        success: false, 
        message: 'A hospital with this phone number already exists.' 
      });
    }
    
    // Get coordinates for pincode
    const coords = await getCoordsFromPincode(pincode);
    
    const { rows } = await pool.query(
      `INSERT INTO hospitals (hospital_name, phone_number, password_hash, address, pincode, email, latitude, longitude, created_at, last_login) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW()) 
       RETURNING hospital_id, hospital_name, phone_number, address, pincode, email`,
      [hospitalName, phoneNumber, password, address, pincode, email, coords.lat, coords.lon]
    );
    
    console.log(`✅ Hospital registered successfully: ${rows[0].hospital_id}`);
    
    res.status(201).json({ 
      success: true, 
      message: 'Hospital registered successfully!',
      hospital: rows[0]
    });
  } catch (e) {
    console.error('❌ Hospital registration error:', e);
    
    if (e.code === '23505') {
      return res.status(409).json({ 
        success: false, 
        message: 'A hospital with this phone number already exists.' 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: 'Database error. Please try again.' 
    });
  }
});

app.post('/api/server/login/hospital', async (req, res) => {
  const { phoneNumber, password } = req.body;
  
  console.log('🏥 Hospital login attempt:', { phoneNumber });
  
  if (!phoneNumber || !password) {
    return res.status(400).json({ 
      success: false, 
      message: 'Phone number and password are required.' 
    });
  }
  
  if (!/^\d{10}$/.test(phoneNumber)) {
    return res.status(400).json({ 
      success: false, 
      message: 'Invalid phone number format.' 
    });
  }
  
  try {
    const { rows } = await pool.query(
      "SELECT hospital_id, hospital_name, phone_number, address, pincode, email, password_hash FROM hospitals WHERE phone_number = $1",
      [phoneNumber]
    );
    
    if (rows.length === 0) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid phone number or password.' 
      });
    }
    
    const hospital = rows[0];
    
    if (password !== hospital.password_hash) {
      console.log('❌ Invalid password for hospital:', phoneNumber);
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid phone number or password.' 
      });
    }
    
    const token = generateSecureToken();
    
    hospitalSessions.set(token, {
      hospitalId: hospital.hospital_id,
      phoneNumber: hospital.phone_number,
      createdAt: Date.now()
    });
    
    await pool.query(
      "UPDATE hospitals SET last_login = NOW() WHERE hospital_id = $1",
      [hospital.hospital_id]
    );
    
    console.log(`✅ Hospital logged in successfully: ${hospital.hospital_id}`);
    
    res.json({ 
      success: true, 
      message: 'Login successful!',
      token: token,
      hospital: {
        hospital_id: hospital.hospital_id,
        hospitalName: hospital.hospital_name,
        phoneNumber: hospital.phone_number,
        address: hospital.address,
        pincode: hospital.pincode,
        email: hospital.email
      }
    });
  } catch (e) {
    console.error('❌ Hospital login error:', e);
    res.status(500).json({ 
      success: false, 
      message: 'Database error. Please try again.' 
    });
  }
});

app.post('/api/server/logout/hospital', authenticateHospital, async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  
  if (token) {
    hospitalSessions.delete(token);
  }
  
  res.json({ 
    success: true, 
    message: 'Logged out successfully.' 
  });
});

app.get('/api/server/verify/hospital', authenticateHospital, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT hospital_id, hospital_name, phone_number, address, pincode, email FROM hospitals WHERE hospital_id = $1",
      [req.hospitalId]
    );
    
    if (rows.length === 0) {
      return res.status(401).json({ 
        success: false, 
        message: 'Hospital not found.' 
      });
    }
    
    res.json({ 
      success: true, 
      hospital: {
        hospital_id: rows[0].hospital_id,
        hospitalName: rows[0].hospital_name,
        phoneNumber: rows[0].phone_number,
        address: rows[0].address,
        pincode: rows[0].pincode,
        email: rows[0].email
      }
    });
  } catch (e) {
    console.error('❌ Hospital verification error:', e);
    res.status(500).json({ 
      success: false, 
      message: 'Server error.' 
    });
  }
});

// ============================================================================
// HOSPITAL BLOOD INVENTORY MANAGEMENT
// ============================================================================

app.get('/api/hospital/inventory', authenticateHospital, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT blood_type, units_available, confidence_level, last_updated 
       FROM blood_inventory 
       WHERE hospital_id = $1 
       ORDER BY blood_type`,
      [req.hospitalId]
    );
    
    res.json({ success: true, inventory: rows });
  } catch (e) {
    console.error('❌ Get inventory error:', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/hospital/inventory/update', authenticateHospital, async (req, res) => {
  const { bloodType, units, confidenceLevel } = req.body;
  
  if (!bloodType || units === undefined || !confidenceLevel) {
    return res.status(400).json({ 
      success: false, 
      message: 'Blood type, units, and confidence level are required.' 
    });
  }
  
  if (units < 0) {
    return res.status(400).json({ 
      success: false, 
      message: 'Units cannot be negative.' 
    });
  }
  
  const validBloodTypes = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
  if (!validBloodTypes.includes(bloodType)) {
    return res.status(400).json({ 
      success: false, 
      message: 'Invalid blood type.' 
    });
  }
  
  try {
    const { rows } = await pool.query(
      `INSERT INTO blood_inventory (hospital_id, blood_type, units_available, confidence_level, last_updated)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (hospital_id, blood_type) 
       DO UPDATE SET 
         units_available = $3, 
         confidence_level = $4, 
         last_updated = NOW()
       RETURNING *`,
      [req.hospitalId, bloodType, units, confidenceLevel]
    );
    
    console.log(`✅ Inventory updated: ${bloodType} = ${units} units`);
    
    res.json({ 
      success: true, 
      message: 'Inventory updated successfully!',
      inventory: rows[0]
    });
  } catch (e) {
    console.error('❌ Update inventory error:', e);
    res.status(500).json({ success: false, message: 'Database error.' });
  }
});

// ============================================================================
// TOKEN VERIFICATION (DONOR & PATIENT)
// ============================================================================

app.post('/api/hospital/verify-tokens', authenticateHospital, async (req, res) => {
  const { donorToken, patientToken } = req.body;
  
  if (!donorToken || !patientToken) {
    return res.status(400).json({ 
      success: false, 
      message: 'Both donor and patient tokens are required.' 
    });
  }
  
  try {
    // Verify donor token
    const donorResult = await pool.query(
      `SELECT dc.*, u.full_name as donor_name, u.phone_number as donor_phone, u.blood_type as donor_blood_type,
              br.blood_type_needed, br.patient_token
       FROM donation_commitments dc
       JOIN users u ON dc.user_id = u.user_id
       JOIN blood_requests br ON dc.request_id = br.request_id
       WHERE dc.donor_token = $1`,
      [donorToken]
    );
    
    // Verify patient token
    const patientResult = await pool.query(
      `SELECT br.*, u.full_name as patient_name, u.phone_number as patient_phone
       FROM blood_requests br
       JOIN users u ON br.patient_id = u.user_id
       WHERE br.patient_token = $1`,
      [patientToken]
    );
    
    if (donorResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Invalid donor token.' 
      });
    }
    
    if (patientResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Invalid patient token.' 
      });
    }
    
    const donor = donorResult.rows[0];
    const patient = patientResult.rows[0];
    
    // Check if tokens match
    const tokensMatch = donor.patient_token === patientToken;
    
    res.json({ 
      success: true, 
      match: tokensMatch,
      message: tokensMatch ? 'Tokens verified and matched!' : 'Tokens do not match.',
      donor: {
        name: donor.donor_name,
        phone: donor.donor_phone,
        bloodType: donor.donor_blood_type,
        token: donorToken,
        status: donor.status
      },
      patient: {
        name: patient.patient_name,
        phone: patient.patient_phone,
        bloodType: patient.blood_type_needed,
        token: patientToken,
        status: patient.status,
        requestId: patient.request_id
      }
    });
  } catch (e) {
    console.error('❌ Token verification error:', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ============================================================================
// HOSPITAL PLAYBOOKS
// ============================================================================

app.get('/api/hospital/playbooks', authenticateHospital, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT playbook_id, title, category, content, created_at, updated_at 
       FROM hospital_playbooks 
       WHERE hospital_id = $1 OR hospital_id IS NULL
       ORDER BY created_at DESC`,
      [req.hospitalId]
    );
    
    res.json({ success: true, playbooks: rows });
  } catch (e) {
    console.error('❌ Get playbooks error:', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/hospital/playbooks', authenticateHospital, async (req, res) => {
  const { title, category, content } = req.body;
  
  if (!title || !content) {
    return res.status(400).json({ 
      success: false, 
      message: 'Title and content are required.' 
    });
  }
  
  try {
    const { rows } = await pool.query(
      `INSERT INTO hospital_playbooks (hospital_id, title, category, content, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       RETURNING *`,
      [req.hospitalId, title, category || 'General', content]
    );
    
    console.log(`✅ Playbook created: ${title}`);
    
    res.status(201).json({ 
      success: true, 
      message: 'Playbook created successfully!',
      playbook: rows[0]
    });
  } catch (e) {
    console.error('❌ Create playbook error:', e);
    res.status(500).json({ success: false, message: 'Database error.' });
  }
});

app.put('/api/hospital/playbooks/:id', authenticateHospital, async (req, res) => {
  const { id } = req.params;
  const { title, category, content } = req.body;
  
  if (!title || !content) {
    return res.status(400).json({ 
      success: false, 
      message: 'Title and content are required.' 
    });
  }
  
  try {
    const { rows } = await pool.query(
      `UPDATE hospital_playbooks 
       SET title = $1, category = $2, content = $3, updated_at = NOW()
       WHERE playbook_id = $4 AND hospital_id = $5
       RETURNING *`,
      [title, category || 'General', content, id, req.hospitalId]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Playbook not found or you do not have permission to edit it.' 
      });
    }
    
    console.log(`✅ Playbook updated: ${title}`);
    
    res.json({ 
      success: true, 
      message: 'Playbook updated successfully!',
      playbook: rows[0]
    });
  } catch (e) {
    console.error('❌ Update playbook error:', e);
    res.status(500).json({ success: false, message: 'Database error.' });
  }
});

app.delete('/api/hospital/playbooks/:id', authenticateHospital, async (req, res) => {
  const { id } = req.params;
  
  try {
    const { rows } = await pool.query(
      `DELETE FROM hospital_playbooks 
       WHERE playbook_id = $1 AND hospital_id = $2
       RETURNING *`,
      [id, req.hospitalId]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Playbook not found or you do not have permission to delete it.' 
      });
    }
    
    console.log(`✅ Playbook deleted: ${id}`);
    
    res.json({ 
      success: true, 
      message: 'Playbook deleted successfully!'
    });
  } catch (e) {
    console.error('❌ Delete playbook error:', e);
    res.status(500).json({ success: false, message: 'Database error.' });
  }
});

// ============================================================================
// SOS MONITOR - VIEW ALL PATIENT REQUESTS
// ============================================================================

app.get('/api/hospital/sos-requests', authenticateHospital, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT br.*, u.full_name as patient_name, u.phone_number as patient_phone,
              CASE 
                WHEN br.accepted_by_hospital_id = $1 THEN true
                ELSE false
              END as is_accepted_by_me
       FROM blood_requests br
       JOIN users u ON br.patient_id = u.user_id
       WHERE br.status IN ('pending', 'escalated', 'accepted')
       ORDER BY br.created_at DESC
       LIMIT 100`,
      [req.hospitalId]
    );
    
    res.json({ success: true, requests: rows });
  } catch (e) {
    console.error('❌ Get SOS requests error:', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ============================================================================
// DONOR APPOINTMENTS
// ============================================================================

app.get('/api/hospital/appointments', authenticateHospital, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT dc.*, u.full_name as donor_name, u.phone_number as donor_phone, u.blood_type,
              br.blood_type_needed, br.patient_token
       FROM donation_commitments dc
       JOIN users u ON dc.user_id = u.user_id
       JOIN blood_requests br ON dc.request_id = br.request_id
       WHERE br.accepted_by_hospital_id = $1
       ORDER BY dc.created_at DESC
       LIMIT 100`,
      [req.hospitalId]
    );
    
    res.json({ success: true, appointments: rows });
  } catch (e) {
    console.error('❌ Get appointments error:', e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ============================================================================
// ADMIN AUTHENTICATION (keeping existing)
// ============================================================================

app.post('/api/server/register/admin', async (req, res) => {
  const { fullName, pincode, phoneNumber, password, accessCode } = req.body;
  
  console.log('🔐 Admin registration attempt:', { fullName, phoneNumber });
  
  if (!fullName || !pincode || !phoneNumber || !password || !accessCode) {
    return res.status(400).json({ 
      success: false, 
      message: 'All fields are required.' 
    });
  }
  
  if (!/^\d{10}$/.test(phoneNumber)) {
    return res.status(400).json({ 
      success: false, 
      message: 'Invalid phone number format. Must be 10 digits.' 
    });
  }
  
  if (!/^\d{6}$/.test(pincode)) {
    return res.status(400).json({ 
      success: false, 
      message: 'Invalid pincode format. Must be 6 digits.' 
    });
  }
  
  if (password.length < 6) {
    return res.status(400).json({ 
      success: false, 
      message: 'Password must be at least 6 characters long.' 
    });
  }
  
  if (accessCode !== ADMIN_ACCESS_CODE) {
    console.log('❌ Invalid access code attempt:', accessCode);
    return res.status(403).json({ 
      success: false, 
      message: 'Invalid access code. Admin registration denied.' 
    });
  }
  
  try {
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
  
  if (!phoneNumber || !password) {
    return res.status(400).json({ 
      success: false, 
      message: 'Phone number and password are required.' 
    });
  }
  
  if (!/^\d{10}$/.test(phoneNumber)) {
    return res.status(400).json({ 
      success: false, 
      message: 'Invalid phone number format.' 
    });
  }
  
  try {
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
    
    if (password !== admin.password_hash) {
      console.log('❌ Invalid password for admin:', phoneNumber);
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid phone number or password.' 
      });
    }
    
    const token = generateSecureToken();
    
    adminSessions.set(token, {
      adminId: admin.user_id,
      phoneNumber: admin.phone_number,
      createdAt: Date.now()
    });
    
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
// PATIENT & VOLUNTEER (keeping existing endpoints - abbreviated for space)
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
// SOS BROADCAST TO ALL HOSPITALS
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
    
    // BROADCAST SOS TO ALL HOSPITALS
    const { rows: hospitals } = await client.query(
      'SELECT hospital_id, hospital_name, phone_number, latitude, longitude FROM hospitals'
    );
    
    let hospitalCount = 0;
    for (const hospital of hospitals) {
      if (hospital.latitude && hospital.longitude) {
        const distance = calculateDistance(
          coords.lat, coords.lon,
          hospital.latitude, hospital.longitude
        );
        
        await client.query(
          'INSERT INTO alert_status (request_id, hospital_id, distance_km, status) VALUES ($1, $2, $3, $4)',
          [requestId, hospital.hospital_id, distance.toFixed(2), 'sent']
        );
        
        hospitalCount++;
        
        console.log(`📡 SOS sent to ${hospital.hospital_name} (${distance.toFixed(2)} km)`);
      }
    }
    
    await client.query('COMMIT');
    
    console.log(`✅ SOS broadcast to ${hospitalCount} hospitals for request ${requestId}`);
    
    res.status(201).json({ 
      success: true, 
      message: `SOS Alert broadcast to ${hospitalCount} hospitals!`,
      request: rows[0],
      hospitalsNotified: hospitalCount
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


// ===========================================================================
// VOLUNTEER MATERIAL GENERATOR
// ===========================================================================

app.post('/api/generate-material', async (req, res) => {
  // Note: This is an unprotected endpoint for simplicity.
  // In a real app, you would verify the 'Authorization' header.

  const { link, title, userId, userType } = req.body;

  if (!link || !title) {
    return res.status(400).json({
      success: false,
      message: 'Missing required fields: link and title'
    });
  }

  try {
    // Use a public API to generate the QR code (as hinted in your frontend)
    const qrApiBase = 'https://api.qrserver.com/v1/create-qr-code/';
    const qrData = encodeURIComponent(link); // Make the link URL-safe
    const qrSize = '200x200';
    
    // This is the final, public URL to the generated QR code image
    const qrImageUrl = `${qrApiBase}?data=${qrData}&size=${qrSize}&format=png`;

    console.log(`✅ Generated QR code for user ${userId} (${userType})`);

    // Send back the response structure your frontend expects
    res.status(200).json({
      success: true,
      message: 'Material generated successfully!',
      material: {
        content_url: qrImageUrl,     // The URL to the QR image
        qr_code_data: link,          // The original link data
        title: title,
        user_id: userId,
      }
    });

  } catch (error) {
    console.error('❌ Error generating QR material:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while generating material.'
    });
  }
});

// ===========================================================================
// (Your existing SERVER START code continues below)
// ===========================================================================

// ============================================================================
// SERVER START
// ============================================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 LifeLink Server running on port ${PORT}`);
  console.log(`🔐 Admin Access Code: ${ADMIN_ACCESS_CODE}`);
  console.log(`🏥 Hospital authentication enabled`);
  console.log(`⚠️  Passwords stored in plain text - NOT secure for production!`);
});

module.exports = app;