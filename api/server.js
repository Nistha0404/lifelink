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

// HELPER FUNCTIONS
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

// ESCALATION LOGIC
async function checkAndEscalate(requestId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const reqRes = await client.query(
      "SELECT status, blood_type_needed FROM blood_requests WHERE request_id = $1 FOR UPDATE",
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
      console.log(`Escalating request ${requestId} to donors...`);
      
      await client.query(
        "UPDATE blood_requests SET status = 'escalated' WHERE request_id = $1",
        [requestId]
      );
      
      const { rows: donors } = await client.query(
        "SELECT user_id, phone_number, full_name FROM users WHERE role = 'donor' AND blood_type = $1",
        [reqRes.rows[0].blood_type_needed]
      );
      
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

// PATIENT AUTHENTICATION
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

// PATIENT SOS
app.post('/api/server/request-blood', async (req, res) => {
  const { patientId, bloodType, pincode, latitude, longitude } = req.body;
  
  console.log('Received SOS Request:', { patientId, bloodType, pincode, latitude, longitude });
  
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

    const insertRequest = `
      INSERT INTO blood_requests 
        (patient_id, blood_type_needed, pincode, latitude, longitude, status, patient_token, deadline)
      VALUES 
        ($1, $2, $3, $4, $5, 'pending', $6, $7)
      RETURNING request_id, patient_token`;
      
    const { rows } = await client.query(insertRequest, [
      patientId, bloodType, pincode, latitude, longitude, patientToken, deadline
    ]);
    
    const requestId = rows[0].request_id;
    console.log(`Created blood request ${requestId} with token ${patientToken}`);

    const { rows: hospitals } = await client.query(
      'SELECT hospital_id, hospital_name, latitude, longitude FROM hospitals WHERE latitude IS NOT NULL AND longitude IS NOT NULL'
    );
    
    console.log(`Found ${hospitals.length} hospitals in database`);
    
    const alertPromises = [];
    let hospitalsNotified = 0;
    
    for (const hospital of hospitals) {
      const distance = calculateDistance(latitude, longitude, hospital.latitude, hospital.longitude);
      
      console.log(`${hospital.hospital_name}: ${distance.toFixed(2)} km away`);
      
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
    
    console.log(`Notified hospitals within 10km`);

    setTimeout(() => {
      console.log(`Timer expired for request ${requestId}`);
      checkAndEscalate(requestId);
    }, 10 * 60 * 1000 + 1000);

    res.status(201).json({ 
      success: true, 
      message: `SOS Alert sent to nearby hospitals!`, 
      requestId, 
      patient_token: rows[0].patient_token
    });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error in request-blood:', e);
    res.status(500).json({ success: false, message: 'Server error: ' + e.message });
  } finally {
    client.release();
  }
});

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

// HOSPITAL AUTHENTICATION
/**
 * API ENDPOINT: Register a New Hospital
 * --------------------------------------
 * UPDATED: Stores the password in plain text, as requested.
 * Saves latitude and longitude to the database.
 */
app.post('/api/server/hospital-register', async (req, res) => {
    
    // Get all data from the request body
    const { 
      hospitalName, 
      address, 
      pincode, 
      phoneNumber, 
      password, // This is the plain text password
      latitude, 
      longitude 
    } = req.body;

    // Validate that we actually received location data
    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ 
        success: false, 
        message: 'Location data (latitude, longitude) is missing. Registration failed.' 
      });
    }

    try {
        const newHospitalId = await generateUniqueHospitalId(); // Assumes this function exists
        
        // --- UPDATED SQL QUERY ---
        // 'password_hash' column will now store the plain text password
        const query = `
            INSERT INTO hospital (
              hospital_id, hospital_name, address, pincode, 
              phone_number, password_hash, latitude, longitude
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING hospital_id;
        `;
        
        // --- UPDATED VALUES ARRAY ---
        // Using the 'password' variable directly instead of a hashed password
        const values = [
          newHospitalId, 
          hospitalName, 
          address, 
          pincode, 
          phoneNumber, 
          password, // Storing plain text password
          latitude, 
          longitude
        ];
        
        // Assumes your database connection pool is named 'pool'
        const result = await pool.query(query, values);
        
        res.status(201).json({ 
          success: true, 
          hospitalId: result.rows[0].hospital_id 
        });

    } catch (error) {
        console.error('Hospital registration error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

/**
 * API ENDPOINT: Hospital Login
 * --------------------------------------
 * UPDATED: Compares plain text passwords.
 */
app.post('/api/server/hospital-login', async (req, res) => {
    const { hospitalId, password } = req.body;

    try {
        // Find the hospital by its ID
        const query = 'SELECT * FROM hospital WHERE hospital_id = $1';
        const result = await pool.query(query, [hospitalId]);

        if (result.rows.length === 0) {
            // No hospital found with that ID
            return res.status(401).json({ success: false, message: 'Invalid Hospital ID or password' });
        }

        const hospital = result.rows[0];

        // --- PASSWORD CHECK ---
        // Direct string comparison instead of bcrypt.compare
        if (password === hospital.password_hash) {
            // Passwords match
            // Remove sensitive data before sending back
            delete hospital.password_hash; 
            
            res.json({ 
              success: true, 
              hospital: hospital 
            });
        } else {
            // Passwords do not match
            res.status(401).json({ success: false, message: 'Invalid Hospital ID or password' });
        }
        
    } catch (error) {
        console.error('Hospital login error:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});


/**
 * API ENDPOINT: Get Location by Pincode
 * --------------------------------------
 * This endpoint provides a fallback for geolocation.
 * It queries the database for any existing hospital with the same pincode
 * and returns its coordinates.
 */
app.get('/api/server/location-by-pincode', async (req, res) => {
  const { pincode } = req.query;

  // Basic validation
  if (!pincode || pincode.length !== 6) {
    return res.status(400).json({ 
      success: false, 
      message: 'A valid 6-digit pincode is required.' 
    });
  }

  try {
    // Find the first hospital with this pincode that has valid coordinates
    const query = `
      SELECT latitude, longitude 
      FROM hospital 
      WHERE pincode = $1 AND latitude IS NOT NULL AND longitude IS NOT NULL
      LIMIT 1
    `;
    
    // Assumes your database connection pool is named 'pool'
    const result = await pool.query(query, [pincode]);

    if (result.rows.length > 0) {
      // Found a match
      res.json({
        success: true,
        latitude: result.rows[0].latitude,
        longitude: result.rows[0].longitude
      });
    } else {
      // No hospital with this pincode (or one with coordinates) exists yet
      res.status(404).json({ 
        success: false, 
        message: 'Could not find a location for this pincode. Please try again later.' 
      });
    }
  } catch (error) {
    console.error('Error fetching location by pincode:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error while fetching location.' 
    });
  }
});

// HOSPITAL SOS MONITOR
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

app.post('/api/server/verify-token', async (req, res) => {
  const { token } = req.body;
  if (!token || token.length !== 4) {
    return res.status(400).json({ success: false, message: '4-digit token required.' });
  }
  
  try {
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

// PLAYBOOKS
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

// ADMIN ROUTES
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

// CAMPS
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

// SERVER START
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LifeLink Server running on port ${PORT}`);
});



module.exports = app;