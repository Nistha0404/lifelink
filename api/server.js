
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();


const otpStore = {};
const donorOtpStore = {};
let donorsDB = []; 
let hospitalsDB = [
  { id: 'HOS101', name: 'City Central Hospital', pincode: '147001', address: '123 Mall Road, Patiala', location: { lat: 30.3398, lon: 76.3869 }, stock: {'O+': 5, 'A+': 10} },
  { id: 'HOS102', name: 'Rajindra Hospital',     pincode: '147004', address: '456 Leela Bhawan, Patiala', location: { lat: 30.3213, lon: 76.4055 }, stock: {'B-': 2, 'AB+': 8} },
  { id: 'HOS103', name: 'General Hospital S22',  pincode: '160022', address: '789 Sector 22, Chandigarh', location: { lat: 30.7415, lon: 76.7681 }, stock: {'O-': 0, 'A+': 3} },
];

app.use(cors());
app.use(express.json());


const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: { rejectUnauthorized: false },
});

const axios = require('axios');
const FAST2SMS_API_KEY = process.env.FAST2SMS_API_KEY; // This gets the key from Vercel environment variables


// helping functions 

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
  return Math.floor(Math.random() * 10000).toString().padStart(4, '0');
}

async function generateUniqueDonorToken(client) {
  for (let i = 0; i < 10; i++) {
    const t = generate4DigitToken();
    const { rows } = await client.query('SELECT 1 FROM donation_commitments WHERE donor_token = $1', [t]);
    if (rows.length === 0) return t;
  }
  throw new Error('Could not generate a unique donor token.');
}

async function generatePatientToken(client) {
  
  for (let i = 0; i < 10; i++) {
    const t = generate4DigitToken();
    const { rows } = await client.query(
      "SELECT 1 FROM blood_requests WHERE patient_token = $1 AND status IN ('active','pending')",
      [t]
    );
    if (rows.length === 0) return t;
  }
  return generate4DigitToken();
}

// ADD THIS new helper function to your server.js
async function checkAndEscalate(requestId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // 1. Lock the request to prevent race conditions
    const reqRes = await client.query(
      "SELECT status FROM blood_requests WHERE request_id = $1 FOR UPDATE", 
      [requestId]
    );
    
    // 2. Check if request is still 'pending' (i.e., not 'accepted' or 'escalated')
    if (!reqRes.rows.length || reqRes.rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return; // Already handled
    }

    // 3. Find all 'sent' alerts for this request
    const sentAlerts = await client.query(
      "SELECT 1 FROM alert_status WHERE request_id = $1 AND status = 'sent'",
      [requestId]
    );

    // 4. If there are NO 'sent' alerts left, it means all have been 'rejected' or 'timed_out'
    if (sentAlerts.rows.length === 0) {
      console.log(`Escalating request ${requestId}...`);
      
      // 5. Update main request status to 'escalated'
      await client.query(
        "UPDATE blood_requests SET status = 'escalated' WHERE request_id = $1", 
        [requestId]
      );
      
      // 6. Find and notify donors (your logic here)
      // Example:
      // const { rows: donors } = await client.query("SELECT * FROM users WHERE role = 'donor' AND blood_type = ... ");
      // for (const donor of donors) {
      //   // io.to(donor.user_id).emit('donor-sos', ...);
      // }
    }
    
    await client.query('COMMIT');
    
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`Error in checkAndEscalate: ${e.message}`);
  } finally {
    client.release();
  }
}

//  PATIENT ki Auth

// REPLACES your existing /api/server/send-otp function
app.post('/api/server/send-otp', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ success: false, message: 'Phone number is required.' });
  try {
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    otpStore[phoneNumber] = { otp, expiry: Date.now() + 300000 };
    
    // This is your current "alert" system. It will run.
    console.log(`Patient OTP for ${phoneNumber}: ${otp}`);

    /* --- FOR FINAL RUN: Un-comment this block and comment the line above ---
    try {
      if (!FAST2SMS_API_KEY) throw new Error('FAST2SMS_API_KEY not set');
      await axios.get('https://www.fast2sms.com/dev/bulkV2', {
        params: {
          authorization: FAST2SMS_API_KEY,
          message: `Your LifeLink patient OTP is ${otp}.`,
          language: 'english',
          route: 'q',
          numbers: phoneNumber
        }
      });
      console.log('Live Patient OTP sent to ' + phoneNumber);
    } catch (smsError) {
      console.error("Fast2SMS Error:", smsError.message);
    }
    --- END OF Fast2SMS BLOCK --- */
    
    res.json({ success: true, otp, message: 'OTP generated.' });
  } catch (e) {
    console.error(e); res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/server/patient-login', async (req, res) => {
  const { phoneNumber, fullName, pincode, latitude, longitude } = req.body;
  try {
    const existing = await pool.query("SELECT * FROM users WHERE phone_number = $1 AND role = 'patient'", [phoneNumber]);
    if (existing.rows.length) {
      const q = `
        UPDATE users SET full_name = $1, pincode = $2, latitude = $3, longitude = $4, last_login = NOW()
        WHERE phone_number = $5 AND role = 'patient'
        RETURNING *`;
      const { rows } = await pool.query(q, [fullName, pincode, latitude, longitude, phoneNumber]);
      return res.json({ success: true, message: 'Login successful!', user: rows[0] });
    }
    if (!fullName || !pincode) {
      return res.status(400).json({ success: false, message: 'Full name and pincode are required for registration.' });
    }
    const ins = `
      INSERT INTO users (full_name, phone_number, role, pincode, latitude, longitude)
      VALUES ($1,$2,'patient',$3,$4,$5) RETURNING *`;
    const { rows } = await pool.query(ins, [fullName, phoneNumber, pincode, latitude, longitude]);
    res.status(201).json({ success: true, message: 'Registration successful!', user: rows[0] });
  } catch (e) {
    console.error(e); res.status(500).json({ success: false, message: 'DB error.' });
  }
});


//  HOSPITAL ki Auth

// NEW: Add this to the top of your file with your other API keys
const OPENCAGE_API_KEY = process.env.OPENCAGE_API_KEY;

// REPLACE your existing /api/server/hospital-register
app.post('/api/server/hospital-register', async (req, res) => {
  // We no longer need latitude/longitude in the body
  const { hospitalName, address, pincode, phoneNumber, password } = req.body;
  
  if (!hospitalName || !pincode || !phoneNumber || !password || !address) {
    return res.status(400).json({ success: false, message: 'All fields are required.' });
  }

  // --- NEW: Geocoding Step ---
  let latitude = null;
  let longitude = null;
  
  try {
    const fullAddress = `${address}, ${pincode}`;
    const geoResponse = await axios.get('https://api.opencagedata.com/geocode/v1/json', {
      params: {
        q: fullAddress,
        key: OPENCAGE_API_KEY,
        limit: 1,
        countrycode: 'in' // Optional: Prioritize results in India
      }
    });

    if (geoResponse.data && geoResponse.data.results.length > 0) {
      const { lat, lng } = geoResponse.data.results[0].geometry;
      latitude = lat;
      longitude = lng;
      console.log(`Geocoded ${hospitalName} to: ${lat}, ${lng}`);
    } else {
      throw new Error('Could not find coordinates for this address.');
    }
  } catch (geoError) {
    console.error("Geocoding Error:", geoError.message);
    // We stop registration if we can't get a location
    return res.status(400).json({ success: false, message: 'Could not validate address. Please check the address and pincode.' });
  }
  // --- End of Geocoding Step ---

  try {
    const existing = await pool.query('SELECT 1 FROM hospitals WHERE phone_number = $1', [phoneNumber]);
    if (existing.rows.length) {
      return res.status(409).json({ success: false, message: 'Phone number already registered.' });
    }

    const last = await pool.query('SELECT hospital_id FROM hospitals ORDER BY hospital_id DESC LIMIT 1');
    const nextNum = last.rows.length ? parseInt(last.rows[0].hospital_id.replace('HOS','')) + 1 : 101;
    const newId = `HOS${nextNum}`;

    const ins = `
      INSERT INTO hospitals (
        hospital_id, hospital_name, address, pincode, phone_number, password_hash, 
        blood_inventory, latitude, longitude
      )
      VALUES ($1, $2, $3, $4, $5, $6, '{}', $7, $8) 
      RETURNING hospital_id`;
    
    const { rows } = await pool.query(ins, [
      newId, hospitalName, address, pincode, phoneNumber, 
      password, // Using plain password
      latitude, // The geocoded latitude
      longitude // The geocoded longitude
    ]);

    res.status(201).json({ success: true, hospitalId: rows[0].hospital_id });
  } catch (e) {
    console.error(e); 
    res.status(500).json({ success: false, message: 'Server error during registration.' });
  }
});

app.post('/api/server/hospital-login', async (req, res) => {
  const { hospitalId, password } = req.body;
  if (!hospitalId || !password) return res.status(400).json({ success: false, message: 'Hospital ID and password are required.' });
  try {
    const { rows } = await pool.query('SELECT * FROM hospitals WHERE hospital_id = $1', [hospitalId.toUpperCase()]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Hospital ID not found.' });
    const hospital = rows[0];
    if (password !== hospital.password_hash) return res.status(401).json({ success: false, message: 'Invalid password.' });
    const { password_hash, ...safe } = hospital;
    res.json({ success: true, hospital: safe });
  } catch (e) {
    console.error(e); res.status(500).json({ success:false, message:'Server error.' });
  }
});


//  HOSPITAL ka dashboard

app.post('/api/server/hospital-sos', async (req, res) => {
  const { hospitalId, component, bloodType, units, urgency } = req.body;
  if (!hospitalId || !component || !bloodType || !units || !urgency) {
    return res.status(400).json({ success: false, message: 'Missing required SOS fields.' });
  }
  try {
    const ins = `
      INSERT INTO blood_requests (creator_hospital_id, blood_type_needed, component_needed, urgency, status)
      VALUES ($1,$2,$3,$4,'active') RETURNING request_id`;
    const { rows } = await pool.query(ins, [hospitalId, bloodType, component, urgency]);
    res.status(201).json({ success: true, message: 'SOS broadcasted!', requestId: rows[0].request_id });
  } catch (e) {
    console.error(e); res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/api/server/update-inventory', async (req, res) => {
  const { hospitalId, inventory } = req.body;
  if (!hospitalId || !inventory) return res.status(400).json({ success: false, message: 'Missing hospital ID or inventory.' });
  try {
    await pool.query('UPDATE hospitals SET blood_inventory = $1 WHERE hospital_id = $2', [inventory, hospitalId]);
    res.json({ success: true, message: 'Stock levels updated.' });
  } catch (e) {
    console.error(e); res.status(500).json({ success:false, message:'DB error.' });
  }
});

app.post('/api/server/donor-checkin', async (req, res) => {
  const { qrToken } = req.body;
  if (!qrToken) return res.status(400).json({ success: false, message: 'QR Token is required.' });
  try {
    const upd = await pool.query(
      "UPDATE donations SET status = 'arrived' WHERE qr_data = $1 AND status = 'scheduled' RETURNING donation_id, donor_id",
      [qrToken]
    );
    if (!upd.rows.length) return res.status(404).json({ success: false, message: 'Invalid or already used token.' });
    res.json({ success: true, message: 'Donor checked in successfully!', donation: upd.rows[0] });
  } catch (e) {
    console.error(e); res.status(500).json({ success:false, message:'Server error.' });
  }
});

// --- NEW: HOSPITAL ACCEPTS AN SOS REQUEST ---
// ADD THIS NEW ENDPOINT. You can DELETE your old /api/server/accept-request
app.post('/api/server/hospital-response', async (req, res) => {
  const { requestId, hospitalId, response } = req.body; // response = 'accept' or 'reject'
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Check if the main request is still 'pending'
    const reqRes = await client.query(
      "SELECT status FROM blood_requests WHERE request_id = $1 FOR UPDATE", 
      [requestId]
    );
    
    if (!reqRes.rows.length || reqRes.rows[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'This request is no longer active.' });
    }

    if (response === 'accept') {
      // 2a. Mark this hospital's alert as 'accepted'
      await client.query(
        "UPDATE alert_status SET status = 'accepted', response_at = NOW() WHERE request_id = $1 AND hospital_id = $2",
        [requestId, hospitalId]
      );
      
      // 2b. Mark all other alerts for this request as 'closed'
      await client.query(
        "UPDATE alert_status SET status = 'closed', response_at = NOW() WHERE request_id = $1 AND hospital_id != $2 AND status = 'sent'",
        [requestId, hospitalId]
      );
      
      // 2c. Update the main blood request
      await client.query(
        "UPDATE blood_requests SET status = 'accepted', accepted_by_hospital_id = $1 WHERE request_id = $2",
        [hospitalId, requestId]
      );

    } else { // response === 'reject'
      // 3. Mark this hospital's alert as 'rejected'
      await client.query(
        "UPDATE alert_status SET status = 'rejected', response_at = NOW() WHERE request_id = $1 AND hospital_id = $2",
        [requestId, hospitalId]
      );
    }
    
    await client.query('COMMIT');
    
    // 4. If rejected, immediately check if escalation is needed
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


// --- NEW: PATIENT CHECKS IF THEIR REQUEST WAS ACCEPTED ---
// REPLACE your existing /api/server/request-status/:requestId
app.get('/api/server/request-status/:requestId', async (req, res) => {
  const { requestId } = req.params;
  try {
    // Check the request status
    const { rows } = await pool.query(
      `SELECT br.status, h.hospital_name, h.pincode
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
      // A hospital accepted!
      res.json({ status: 'pending', hospital: { hospital_name: request.hospital_name, pincode: request.pincode } });
    } else if (request.status === 'escalated') {
      // No hospitals accepted, it went to donors
      res.json({ status: 'escalated', hospital: null });
    } else {
      // Still 'pending' (no hospital has accepted yet)
      res.json({ status: 'active', hospital: null });
    }

  } catch (e) {
    console.error(e);
    res.status(500).json({ status: 'error', message: 'Server error.' });
  }
});


//  SHARED: SOS + HISTORY + TWO-STAGE TOKENS


// PATIENT SOS: create request + patient_token + notify hospitals
// REPLACE your existing /api/server/request-blood
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

    const patientToken = await generatePatientToken(client);
    const deadline = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes from now

    // 1. Create the main request with 'pending' status and deadline
    const ins = `
      INSERT INTO blood_requests (patient_id, creator_user_id, blood_type_needed, pincode, latitude, longitude, status, patient_token, deadline)
      VALUES ($1, $1, $2, $3, $4, $5, 'pending', $6, $7)
      RETURNING request_id, patient_token`;
      
    const { rows } = await client.query(ins, [patientId, bloodType, pincode, latitude, longitude, patientToken, deadline]);
    const requestId = rows[0].request_id;

    // 2. Find nearby hospitals (within 10km)
    const { rows: hospitals } = await client.query('SELECT hospital_id, latitude, longitude FROM hospitals');
    const alertPromises = [];
    
    for (const h of hospitals) {
      const dist = calculateDistance(latitude, longitude, h.latitude, h.longitude);
      
      if (dist <= 10) { // <-- Your 10km radius logic
        // 3. Insert into the NEW alert_status table
        alertPromises.push(
          client.query(
            'INSERT INTO alert_status (request_id, hospital_id, distance, status) VALUES ($1, $2, $3, $4)',
            [requestId, h.hospital_id, dist, 'sent']
          )
        );
      }
    }
    await Promise.all(alertPromises);

    await client.query('COMMIT');

    // 4. Set the 10-minute server-side timer to check for escalation
    setTimeout(() => {
      checkAndEscalate(requestId);
    }, 10 * 60 * 1000 + 1000); // 10 mins + 1 sec buffer

    res.status(201).json({ 
      success: true, 
      message: `SOS Alert sent to ${alertPromises.length} nearby hospitals!`, 
      requestId, 
      patient_token: rows[0].patient_token 
    });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e); 
    res.status(500).json({ success:false, message:'Internal server error.' });
  } finally {
    client.release();
  }
});

// Hospital live SOS monitor 
// REPLACE your existing /api/server/sos-alerts/:hospitalId
app.get('/api/server/sos-alerts/:hospitalId', async (req, res) => {
  const { hospitalId } = req.params;
  try {
    // Find alerts for this hospital that are still 'sent'
    const q = `
      SELECT 
        br.request_id,
        br.blood_type_needed,
        br.patient_token,
        br.deadline,
        u.full_name AS patient_name,
        als.distance
      FROM alert_status als
      JOIN blood_requests br ON als.request_id = br.request_id
      JOIN users u ON br.patient_id = u.user_id
      WHERE als.hospital_id = $1
        AND als.status = 'sent'
        AND br.status = 'pending' -- Check if request is still active
      ORDER BY als.created_at DESC
    `;
    const { rows } = await pool.query(q, [hospitalId.toUpperCase()]);

    // Format the data for the client
    const alerts = rows.map(req => ({
      requestId: req.request_id,
      patientName: req.patient_name,
      bloodType: req.blood_type_needed,
      patientToken: req.patient_token,
      distance: parseFloat(req.distance), // Ensure it's a number
      deadline: req.deadline // Pass the absolute deadline
    }));

    res.json(alerts);

  } catch (e) {
    console.error("Error in /api/server/sos-alerts/:", e); 
    res.status(500).json({ message: 'Server error fetching alerts.' });
  }
});
//  Patient history 
app.get('/api/server/requests/history/:patientId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT request_id, blood_type_needed, pincode, status, created_at, patient_token
       FROM blood_requests WHERE patient_id = $1 ORDER BY created_at DESC`,
      [req.params.patientId]
    );
    res.json(rows);
  } catch (e) {
    console.error(e); res.status(500).json([]);
  }
});


//  DONOR ki AUTH 

// REPLACES your existing /api/server/donor/generate-otp function
app.post('/api/server/donor/generate-otp', async (req, res) => {
  const { phoneNumber } = req.body;
  try {
    const { rows } = await pool.query("SELECT user_id FROM users WHERE phone_number = $1 AND role = 'donor'", [phoneNumber]);
    if (!rows.length) return res.status(404).json({ success:false, message:'Not a registered donor.' });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[phoneNumber] = { otp, expiry: Date.now() + 300000 };

    // This is your current "alert" system. It will run.
    console.log(`Donor login OTP for ${phoneNumber}: ${otp}`);

    /* --- FOR FINAL RUN: Un-comment this block and comment the line above ---
    try {
      if (!FAST2SMS_API_KEY) throw new Error('FAST2SMS_API_KEY not set');
      await axios.get('https.www.fast2sms.com/dev/bulkV2', {
        params: {
          authorization: FAST2SMS_API_KEY,
          message: `Your LifeLink login OTP is ${otp}.`,
          language: 'english',
          route: 'q',
          numbers: phoneNumber
        }
      });
      console.log('Live Donor Login OTP sent to ' + phoneNumber);
    } catch (smsError) {
      console.error("Fast2SMS Error:", smsError.message);
    }
    --- END OF Fast2SMS BLOCK --- */

    res.json({ success:true, otp, message:'OTP generated.' });
  } catch (e) {
    console.error(e); res.status(500).json({ success:false, message:'Server error.' });
  }
});

app.post('/api/server/donor/login', async (req, res) => {
  const { phoneNumber, otp } = req.body;
  const record = otpStore[phoneNumber];
  if (!record || record.otp !== otp || Date.now() >= record.expiry) {
    return res.status(401).json({ success:false, message:'Invalid or expired OTP.' });
  }
  try {
    delete otpStore[phoneNumber];
    const { rows } = await pool.query("SELECT user_id, full_name, phone_number, pincode, blood_type, role FROM users WHERE phone_number = $1 AND role = 'donor'", [phoneNumber]);
    res.json({ success:true, message:'Login successful!', user: rows[0] });
  } catch (e) {
    console.error(e); res.status(500).json({ success:false, message:'DB error.' });
  }
});

app.post('/api/server/donor/register-request', async (req, res) => {
  const { phoneNumber } = req.body;
  try {
    const ex = await pool.query('SELECT 1 FROM users WHERE phone_number = $1', [phoneNumber]);
    if (ex.rows.length) return res.status(409).json({ success:false, message:'Phone already registered.' });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[phoneNumber] = { otp, expiry: Date.now() + 300000 };
    console.log(`Donor register OTP for ${phoneNumber}: ${otp}`);
    res.json({ success:true, otp, message:'OTP sent.' });
  } catch (e) {
    console.error(e); res.status(500).json({ success:false, message:'Server error.' });
  }
});

app.post('/api/server/donor/register-confirm', async (req, res) => {
  const { fullName, phoneNumber, pincode, bloodType, otp } = req.body;
  const record = otpStore[phoneNumber];
  if (!record || record.otp !== otp || Date.now() >= record.expiry) {
    return res.status(400).json({ success:false, message:'Invalid or expired OTP.' });
  }
  try {
    const ins = `
      INSERT INTO users (full_name, phone_number, pincode, blood_type, role)
      VALUES ($1,$2,$3,$4,'donor') RETURNING user_id`;
    await pool.query(ins, [fullName, phoneNumber, pincode, bloodType]);
    delete otpStore[phoneNumber];
    res.status(201).json({ success:true, message:'Registration successful!' });
  } catch (e) {
    console.error(e); res.status(500).json({ success:false, message:'DB error.' });
  }
});


//  DONOR ACCEPTS REQUEST (Two-Stage: donor_token)

app.post('/api/donor/accept-request', async (req, res) => {
  const { requestId, donorId } = req.body;
  if (!requestId || !donorId) return res.status(400).json({ success:false, message:'requestId and donorId are required.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const reqRow = await client.query('SELECT request_id, status FROM blood_requests WHERE request_id = $1', [requestId]);
    if (!reqRow.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success:false, message:'Request not found.' });
    }

    const donorRow = await client.query("SELECT user_id FROM users WHERE user_id = $1 AND role = 'donor'", [donorId]);
    if (!donorRow.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success:false, message:'Donor not found.' });
    }

    // prevent duplicate donor 
    const exists = await client.query(
      'SELECT donor_token FROM donation_commitments WHERE request_id = $1 AND donor_id = $2',
      [requestId, donorId]
    );
    if (exists.rows.length) {
      await client.query('COMMIT');
      return res.json({ success:true, message:'Already committed.', donor_token: exists.rows[0].donor_token });
    }

    const donorToken = await generateUniqueDonorToken(client);
    const ins = await client.query(
      `INSERT INTO donation_commitments (request_id, donor_id, donor_token, status)
       VALUES ($1,$2,$3,'committed')
       RETURNING commitment_id, donor_token`,
      [requestId, donorId, donorToken]
    );

    await client.query('COMMIT');
    res.status(201).json({ success:true, message:'Request accepted.', donor_token: ins.rows[0].donor_token });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e?.code === '23505') {
      return res.status(409).json({ success:false, message:'Token collision, retry.' });
    }
    console.error(e); res.status(500).json({ success:false, message:'Server error.' });
  } finally {
    client.release();
  }
});


//  HOSPITAL token verification

// token
app.post('/api/hospital/verify-token', async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string' || token.length !== 4) {
    return res.status(400).json({ success:false, message:'A 4-digit token is required.' });
  }
  try {
    //patient_token
    const p = await pool.query(
      `SELECT br.request_id, br.patient_id, br.patient_token, br.blood_type_needed, br.pincode,
              u.full_name AS patient_name
         FROM blood_requests br
         JOIN users u ON u.user_id = br.patient_id
        WHERE br.patient_token = $1
        LIMIT 1`,
      [token]
    );
    if (p.rows.length) {
      const r = p.rows[0];
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

    //donor_token
    const d = await pool.query(
      `SELECT dc.commitment_id, dc.request_id, dc.donor_id, dc.donor_token, dc.status AS commitment_status,
              du.full_name AS donor_name, du.blood_type AS donor_blood_type, du.last_donation_date,
              br.patient_token
         FROM donation_commitments dc
         JOIN users du ON du.user_id = dc.donor_id
         JOIN blood_requests br ON br.request_id = dc.request_id
        WHERE dc.donor_token = $1
        LIMIT 1`,
      [token]
    );
    if (d.rows.length) {
      const r = d.rows[0];
      return res.json({
        success: true,
        type: 'donor',
        donor_token: r.donor_token,
        donor: {
          user_id: r.donor_id,
          full_name: r.donor_name,
          blood_type: r.donor_blood_type,
          last_donation_date: r.last_donation_date || null
        },
        matched_patient_token: r.patient_token,
        request_id: r.request_id,
        commitment_id: r.commitment_id,
        commitment_status: r.commitment_status
      });
    }

    res.status(404).json({ success:false, message:'Token not found.' });
  } catch (e) {
    console.error(e); res.status(500).json({ success:false, message:'Server error.' });
  }
});

//
// --- NEW SOS REAL-TIME FLOW ---
//

// 1. GET /api/sos/active/:donorId
//    Gets active SOS requests for the donor's blood type (for the new SOS log)
app.get('/api/sos/active/:donorId', async (req, res) => {
  const { donorId } = req.params;
  try {
    const donor = await pool.query('SELECT blood_type FROM users WHERE user_id = $1', [donorId]);
    if (!donor.rows.length) {
      return res.status(404).json({ success: false, message: 'Donor not found.' });
    }
    const { blood_type } = donor.rows[0];

    // Find active requests ('pending') for the donor's blood type
    // that this donor has NOT already committed to.
    const requests = await pool.query(
      `SELECT br.request_id, br.patient_name, br.required_blood_type, br.location_lat, br.location_lon
       FROM blood_requests br
       WHERE br.required_blood_type = $1
         AND br.status = 'pending'
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
    res.status(500).json({ success: false, message: 'Server error fetching SOS requests.' });
  }
});


// 2. POST /api/sos/verify-location
//    Verifies if donor is within 10km of the patient
app.post('/api/sos/verify-location', async (req, res) => {
  const { sosId, donorLat, donorLon } = req.body;
  
  try {
    const r = await pool.query(
      'SELECT location_lat, location_lon FROM blood_requests WHERE request_id = $1',
      [sosId]
    );
    if (!r.rows.length) {
      return res.status(404).json({ success: false, message: 'Request not found.' });
    }

    const patient = r.rows[0];
    
    // --- Uses your 'calculateDistance' function ---
    const distance = calculateDistance(
      patient.location_lat,
      patient.location_lon,
      donorLat,
      donorLon
    );
    
    const isVerified = distance <= 10; // The 10km check!

    if (isVerified) {
      res.json({ 
        success: true, 
        verified: true, 
        distance: distance.toFixed(2) // e.g., "8.45"
      });
    } else {
      res.json({
        success: true,
        verified: false,
        distance: distance.toFixed(2),
        message: `You are ${distance.toFixed(1)} km away. You must be within 10km to accept.`
      });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error verifying location.' });
  }
});


// 3. POST /api/sos/confirm-commitment
//    Assigns hospital, creates token, and notifies.
app.post('/api/sos/confirm-commitment', async (req, res) => {
  const { sosId, donorId, donorLat, donorLon } = req.body;

  const client = await pool.connect();
  try {
    // Start a transaction
    await client.query('BEGIN');

    // Get patient's location and token (and lock the row)
    const reqRes = await client.query(
      'SELECT location_lat, location_lon, patient_token FROM blood_requests WHERE request_id = $1 FOR UPDATE',
      [sosId]
    );
    if (!reqRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Request not found.' });
    }
    const patientLat = reqRes.rows[0].location_lat;
    const patientLon = reqRes.rows[0].location_lon;
    const patientToken = reqRes.rows[0].patient_token; // For WebSocket flash

    // --- Find Closest Hospital to the PATIENT ---
    // (Assumes you have a 'hospitals' table with 'lat' and 'lon' columns)
    const hospitalRes = await client.query(
      `SELECT hospital_id, name, lat, lon,
        ( 6371 * acos( cos( radians($1) ) * cos( radians( lat ) ) * cos( radians( lon ) - radians($2) ) + sin( radians($1) ) * sin( radians( lat ) ) ) ) AS distance
       FROM hospitals
       ORDER BY distance
       LIMIT 1`,
      [patientLat, patientLon]
    );
    
    if (!hospitalRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'No hospitals found.' });
    }
    const assignedHospital = hospitalRes.rows[0];

    // --- Create Donation Commitment & Donor Token ---
    const donorToken = `DON-${Math.random().toString(36).substr(2, 8).toUpperCase()}`;

    await client.query(
      `INSERT INTO donation_commitments (request_id, donor_id, hospital_id, donor_token, status, donor_lat_on_accept, donor_lon_on_accept)
       VALUES ($1, $2, $3, $4, 'accepted', $5, $6)
       RETURNING commitment_id`,
      [sosId, donorId, assignedHospital.hospital_id, donorToken, donorLat, donorLon]
    );

    // Update the blood request to 'in_progress' and assign the hospital
    await client.query(
      "UPDATE blood_requests SET status = 'in_progress', assigned_hospital_id = $1 WHERE request_id = $2",
      [assignedHospital.hospital_id, sosId]
    );

    // Commit the transaction
    await client.query('COMMIT');

    // --- !! PATIENT PAGE FLASH !! ---
    // --- Uses your 'calculateDistance' function ---
    const etaKm = calculateDistance(donorLat, donorLon, assignedHospital.lat, assignedHospital.lon);
    const etaMinutes = Math.round((etaKm / 30) * 60); // Assuming 30km/h avg speed
    
    console.log(`(SIMULATE WEBSOCKET) Sending to Patient ${patientToken}:`);
    console.log(`- Donor confirmed! Please go to ${assignedHospital.name}.`);
    console.log(`- Donor is ${etaKm.toFixed(1)} km away (${etaMinutes} mins).`);
    console.log(`- Token: ${donorToken}`);
    // e.g., io.to(patientToken).emit('donor_confirmed', { hospital: assignedHospital.name, distance: etaKm.toFixed(1), time: etaMinutes, token: donorToken });

    // Send the good news back to the donor
    res.json({
      success: true,
      hospital: {
        name: assignedHospital.name,
        lat: assignedHospital.lat,
        lon: assignedHospital.lon
      },
      donor_token: donorToken
    });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error confirming commitment.' });
  } finally {
    client.release();
  }
});

//
//
// --- REPLACE your existing /api/donor/active-token/:donorId with this one ---
//


//  PLAYBOOKS  

app.get('/api/server/playbooks/:hospitalId', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM playbooks WHERE hospital_id = $1 ORDER BY updated_at DESC", [req.params.hospitalId]);
    res.json(rows);
  } catch { res.json([]); }
});

app.post('/api/server/playbooks', async (req, res) => {
  const { hospitalId, title, content } = req.body;
  try {
    const { rows } = await pool.query(
      "INSERT INTO playbooks (hospital_id, title, content) VALUES ($1,$2,$3) RETURNING *",
      [hospitalId, title, content]
    );
    res.status(201).json({ success:true, playbook: rows[0] });
  } catch {
    res.status(500).json({ success:false, message:'Failed to save playbook.' });
  }
});

app.get('/api/server/reports/:hospitalId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT status, COUNT(request_id) as count
         FROM blood_requests
        WHERE creator_hospital_id = $1
        GROUP BY status`,
      [req.params.hospitalId]
    );
    res.json(rows);
  } catch (e) {
    console.error(e); res.status(500).json({ message:'Failed to generate report.' });
  }
});


//
// --- ADD THIS: VOLUNTEER & NGO AUTH ---
//

// 1. GENERATE OTP FOR VOLUNTEER/NGO
app.post('/api/volunteer/generate-otp', async (req, res) => {
  const { phoneNumber } = req.body;

  if (!phoneNumber || !/^\d{10}$/.test(phoneNumber)) {
    return res.status(400).json({ success: false, message: 'A valid 10-digit phone number is required.' });
  }

  try {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[phoneNumber] = { otp, expiry: Date.now() + 300000 }; // 5-minute expiry

    // This sends the OTP back to the client for the alert
    console.log(`Volunteer/NGO OTP for ${phoneNumber}: ${otp}`);
    res.json({ success: true, otp: otp, message: 'OTP generated.' });

  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});


// 2. VERIFY OTP, THEN LOGIN OR REGISTER VOLUNTEER/NGO
app.post('/api/volunteer/verify-login', async (req, res) => {
  const {
    type,           // 'volunteer' or 'ngo'
    fullName,       // For volunteer
    ngoName,        // For NGO
    registrationId, // For NGO
    phoneNumber,
    otp
  } = req.body;

  // 1. Verify OTP
  const record = otpStore[phoneNumber];
  if (!record || record.otp !== otp || Date.now() >= record.expiry) {
    return res.status(401).json({ success: false, message: 'Invalid or expired OTP.' });
  }

  // OTP is valid, delete it
  delete otpStore[phoneNumber];

  // 2. Find or Create User
  try {
    // Check if user already exists
    const { rows } = await pool.query(
      "SELECT user_id, full_name, phone_number, role, registration_id FROM users WHERE phone_number = $1 AND (role = 'volunteer' OR role = 'ngo')",
      [phoneNumber]
    );

    // --- A: User exists, LOG THEM IN ---
    if (rows.length) {
      const user = rows[0];
      // Update their info just in case they switched types
      const updateName = (type === 'volunteer') ? fullName : ngoName;
      await pool.query(
        "UPDATE users SET full_name = $1, role = $2, registration_id = $3 WHERE user_id = $4",
        [updateName, type, (type === 'ngo') ? registrationId : null, user.user_id]
      );
      user.full_name = updateName; // Send back the updated name
      user.role = type;
      return res.json({ success: true, message: 'Login successful!', user: user });
    }
    
    // --- B: User doesn't exist, REGISTER THEM ---
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


//app.get('/api/server/health', (req, res) => {
//  res.json({ status: 'ok', message: 'Server is running' });
//});

// --- ADD THIS CODE TO YOUR server.js FILE ---

/**
 * Endpoint 1: Donor schedules a casual donation
 * Finds the closest hospital within 10km and creates a 'Scheduled' commitment.
 */
app.post('/api/donor/schedule-casual-donation', async (req, res) => {
    const { donorId, latitude, longitude, pincode, bloodType, date, timeSlot } = req.body;

    if (!donorId || !bloodType || !date || !timeSlot) {
        return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    // This is a 4-digit token, e.g., "1234"
    const donorToken = Math.floor(1000 + Math.random() * 9000).toString();
    
    try {
        let findHospitalQuery;
        let queryParams;

        if (latitude && longitude) {
            // OPTION 1: Use Geolocation (Haversine formula for distance in km)
            // This query finds the closest hospital within a 10km radius
            findHospitalQuery = `
                SELECT hospital_id, hospital_name, (
                    6371 * acos(
                        cos(radians($1)) * cos(radians(latitude)) *
                        cos(radians(longitude) - radians($2)) +
                        sin(radians($1)) * sin(radians(latitude))
                    )
                ) AS distance
                FROM hospitals
                HAVING (
                    6371 * acos(
                        cos(radians($1)) * cos(radians(latitude)) *
                        cos(radians(longitude) - radians($2)) +
                        sin(radians($1)) * sin(radians(latitude))
                    )
                ) < 10
                ORDER BY distance ASC
                LIMIT 1;
            `;
            queryParams = [latitude, longitude];

        } else if (pincode) {
            // OPTION 2: Use Pincode (Backup)
            // This just finds *any* hospital with the same pincode
            findHospitalQuery = `
                SELECT hospital_id, hospital_name 
                FROM hospitals 
                WHERE pincode = $1 
                LIMIT 1;
            `;
            queryParams = [pincode];

        } else {
            return res.status(400).json({ success: false, message: 'No location or pincode provided.' });
        }

        // Find the hospital
        const hospitalRes = await pool.query(findHospitalQuery, queryParams);

        if (hospitalRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'No hospitals found within 10km or matching that pincode.' });
        }

        const hospital = hospitalRes.rows[0];

        // Create the commitment
        const commitQuery = `
            INSERT INTO commitments (
                donor_id, hospital_id, commitment_type, status, 
                appointment_date, appointment_time, donor_token
            )
            VALUES ($1, $2, 'Casual', 'Scheduled', $3, $4, $5)
            RETURNING *;
        `;
        const commitParams = [donorId, hospital.hospital_id, date, timeSlot, donorToken];
        await pool.query(commitQuery, commitParams);

        res.status(201).json({ success: true, hospital: hospital });

    } catch (err) {
        console.error('Scheduling Error:', err);
        res.status(500).json({ success: false, message: 'Server database error.' });
    }
});


/**
 * Endpoint 2: Hospital fetches its scheduled donor appointments
 */
app.get('/api/hospital/appointments/:hospitalId', async (req, res) => {
    const { hospitalId } = req.params;

    try {
        const query = `
            SELECT 
                c.commitment_id, c.status, c.appointment_date, c.appointment_time,
                u.full_name, u.blood_type
            FROM commitments c
            JOIN users u ON c.donor_id = u.user_id
            WHERE c.hospital_id = $1
              AND c.commitment_type = 'Casual'
              AND c.status = 'Scheduled'
            ORDER BY c.appointment_date, c.appointment_time;
        `;
        const { rows } = await pool.query(query, [hospitalId]);
        res.json({ success: true, data: rows });

    } catch (err) {
        console.error('Fetch Appointments Error:', err);
        res.status(500).json({ success: false, message: 'Server database error.' });
    }
});


/**
 * MODIFICATION: Your existing /api/donor/active-token endpoint
 * It must now also return hospital details for the UI.
 */
app.get('/api/donor/active-token/:donorId', async (req, res) => {
    const { donorId } = req.params;
    try {
        // Find an active commitment (Scheduled or In-Progress)
        // AND JOIN with hospitals table
        const query = `
            SELECT 
                c.donor_token, c.appointment_date, c.appointment_time, c.status,
                h.hospital_name, h.pincode
            FROM commitments c
            JOIN hospitals h ON c.hospital_id = h.hospital_id
            WHERE c.donor_id = $1 
              AND (c.status = 'Scheduled' OR c.status = 'In-Progress')
            ORDER BY c.created_at DESC
            LIMIT 1;
        `;
        const { rows } = await pool.query(query, [donorId]);

        if (rows.length > 0) {
            // Send back the commitment AND the hospital info
            res.json({ 
                success: true, 
                commitment: rows[0],
                hospital: {
                    hospital_name: rows[0].hospital_name,
                    pincode: rows[0].pincode
                }
            });
        } else {
            res.json({ success: false, message: 'No active commitment found.' });
        }
    } catch (e) {
        console.error('Active Token Error:', e);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});


module.exports=app;