
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


//  PATIENT ki Auth

app.post('/api/server/send-otp', async (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) return res.status(400).json({ success: false, message: 'Phone number is required.' });
  try {
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    otpStore[phoneNumber] = { otp, expiry: Date.now() + 300000 };
    console.log(`Patient OTP for ${phoneNumber}: ${otp}`);
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

app.post('/api/server/hospital-register', async (req, res) => {
  const { hospitalName, address, pincode, phoneNumber, password } = req.body;
  if (!hospitalName || !pincode || !phoneNumber || !password) {
    return res.status(400).json({ success: false, message: 'All fields are required.' });
  }
  try {
    const existing = await pool.query('SELECT 1 FROM hospitals WHERE phone_number = $1', [phoneNumber]);
    if (existing.rows.length) return res.status(409).json({ success: false, message: 'Phone number already registered.' });

    const last = await pool.query('SELECT hospital_id FROM hospitals ORDER BY hospital_id DESC LIMIT 1');
    const nextNum = last.rows.length ? parseInt(last.rows[0].hospital_id.replace('HOS','')) + 1 : 101;
    const newId = `HOS${nextNum}`;
    const ins = `
      INSERT INTO hospitals (hospital_id, hospital_name, address, pincode, phone_number, password_hash, blood_inventory)
      VALUES ($1,$2,$3,$4,$5,$6,'{}') RETURNING hospital_id`;
    const { rows } = await pool.query(ins, [newId, hospitalName, address, pincode, phoneNumber, password]);
    res.status(201).json({ success: true, hospitalId: rows[0].hospital_id });
  } catch (e) {
    console.error(e); res.status(500).json({ success: false, message: 'Server error.' });
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


//  SHARED: SOS + HISTORY + TWO-STAGE TOKENS


// PATIENT SOS: create request + patient_token + notify hospitals
app.post('/api/server/request-blood', async (req, res) => {
  const { patientId, bloodType, pincode, latitude, longitude } = req.body;
  if (!patientId || !bloodType || !pincode) {
    return res.status(400).json({ success: false, message: 'Missing required fields.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const patientToken = await generatePatientToken(client);

    const ins = `
      INSERT INTO blood_requests (patient_id, creator_user_id, blood_type_needed, pincode, latitude, longitude, status, patient_token)
      VALUES ($1,$1,$2,$3,$4,$5,'active',$6)
      RETURNING request_id, patient_token`;
    const { rows } = await client.query(ins, [patientId, bloodType, pincode, latitude, longitude, patientToken]);
    const requestId = rows[0].request_id;
    const patient_token = rows[0].patient_token;

    // fanout: notify nearby hospitals 
    const { rows: hospitals } = await client.query('SELECT hospital_id, pincode, latitude, longitude FROM hospitals');
    const promises = [];
    for (const h of hospitals) {
      const dist = calculateDistance(latitude, longitude, h.latitude, h.longitude);
      if (dist <= 15 || h.pincode === pincode) {
        promises.push(client.query('INSERT INTO sos_notifications (request_id, hospital_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [requestId, h.hospital_id]));
      }
    }
    await Promise.all(promises);

    await client.query('COMMIT');
    res.status(201).json({ success: true, message: 'SOS Alert sent to nearby hospitals!', requestId, patient_token });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e); res.status(500).json({ success:false, message:'Internal server error.' });
  } finally {
    client.release();
  }
});

// Hospital live SOS monitor 
app.get('/api/server/sos-alerts/:hospitalId', async (req, res) => {
  const { hospitalId } = req.params;
  const lastTimestamp = req.query.lastTimestamp || '1970-01-01T00:00:00.000Z';
  try {
    const q = `
      SELECT br.request_id, br.blood_type_needed, br.pincode, br.created_at, br.patient_token
      FROM blood_requests br
      JOIN sos_notifications sn ON br.request_id = sn.request_id
      WHERE sn.hospital_id = $1
        AND br.status IN ('active','pending')
        AND br.created_at > $2
      ORDER BY br.created_at ASC`;
    const { rows } = await pool.query(q, [hospitalId.toUpperCase(), lastTimestamp]);
    res.json(rows);
  } catch (e) {
    console.error(e); res.status(500).json({ message: 'Server error fetching alerts.' });
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

app.post('/api/server/donor/generate-otp', async (req, res) => {
  const { phoneNumber } = req.body;
  try {
    const { rows } = await pool.query("SELECT user_id FROM users WHERE phone_number = $1 AND role = 'donor'", [phoneNumber]);
    if (!rows.length) return res.status(404).json({ success:false, message:'Not a registered donor.' });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[phoneNumber] = { otp, expiry: Date.now() + 300000 };
    console.log(`Donor login OTP for ${phoneNumber}: ${otp}`);
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


//  PLAYBOOKS & REPORTS 

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


//app.get('/api/server/health', (req, res) => {
//  res.json({ status: 'ok', message: 'Server is running' });
//});


module.exports=app;