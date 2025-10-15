// ---------------------------------
//  SETUP & IMPORTS
// ---------------------------------
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
// --- START: PUSHER INTEGRATION ---
const Pusher = require('pusher');
// --- END: PUSHER INTEGRATION ---

const app = express();
const otpStore = {};

const donorOtpStore = {}; // Use a separate store for donor OTPs
let donorsDB = []; // In-memory donor database
let hospitalsDB = [ // In-memory hospital database for simulation
    { id: 'HOS101', name: 'City Central Hospital', pincode: '147001', address: '123 Mall Road, Patiala', location: { lat: 30.3398, lon: 76.3869 }, stock: {'O+': 5, 'A+': 10} },
    { id: 'HOS102', name: 'Rajindra Hospital', pincode: '147004', address: '456 Leela Bhawan, Patiala', location: { lat: 30.3213, lon: 76.4055 }, stock: {'B-': 2, 'AB+': 8} },
    { id: 'HOS103', name: 'General Hospital Sector 22', pincode: '160022', address: '789 Sector 22, Chandigarh', location: { lat: 30.7415, lon: 76.7681 }, stock: {'O-': 0, 'A+': 3} },
];

// Middleware
app.use(cors());
app.use(express.json());

// --- START: PUSHER INTEGRATION ---
// Initialize Pusher with your credentials.
const pusher = new Pusher({
  appId: "2064101",
  key: "fe426ad42d7dc0ba7dfa",
  secret: "2f5bda6c639ff6cd5a04",
  cluster: "ap2",
  useTLS: true
});
// --- END: PUSHER INTEGRATION ---

//  DATABASE CONFIGURATION (UPDATED FOR VERCEL)
// ---------------------------------
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// ==========================================================================
//  GEOLOCATION HELPER FUNCTION
// ==========================================================================
function calculateDistance(lat1, lon1, lat2, lon2) {
    if (!lat1 || !lon1 || !lat2 || !lon2) return Infinity;
    const R = 6371; // Radius of the Earth in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// ==========================================================================
//  PATIENT AUTHENTICATION
// ==========================================================================
app.post('/api/server/send-otp', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
        return res.status(400).json({ success: false, message: 'Phone number is required.' });
    }
    try {
        const otp = Math.floor(1000 + Math.random() * 9000).toString();
        otpStore[phoneNumber] = { otp, expiry: Date.now() + 300000 };
        console.log(`Generated OTP for ${phoneNumber}: ${otp}`);
        res.status(200).json({ success: true, message: 'OTP generated.', otp: otp });
    } catch (error) {
        console.error('Error in /send-otp:', error);
        res.status(500).json({ success: false, message: 'A server error occurred.' });
    }
});

app.post('/api/server/patient-login', async (req, res) => {
    const { phoneNumber, fullName, pincode, latitude, longitude } = req.body;
    try {
        const userCheck = await pool.query('SELECT * FROM users WHERE phone_number = $1 AND role = \'patient\'', [phoneNumber]);
        let user;
        if (userCheck.rows.length > 0) {
            const updateUserQuery = `
                UPDATE users SET full_name = $1, pincode = $2, latitude = $3, longitude = $4, last_login = NOW()
                WHERE phone_number = $5 AND role = 'patient' RETURNING *;`;
            const updatedUserResult = await pool.query(updateUserQuery, [fullName, pincode, latitude, longitude, phoneNumber]);
            user = updatedUserResult.rows[0];
            res.status(200).json({ success: true, message: 'Login successful!', user: user });
        } else {
            if (!fullName || !pincode) {
                return res.status(400).json({ success: false, message: 'Full name and pincode are required for registration.' });
            }
            const newUserQuery = `
                INSERT INTO users (full_name, phone_number, role, pincode, latitude, longitude) 
                VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;`;
            const newUserResult = await pool.query(newUserQuery, [fullName, phoneNumber, 'patient', pincode, latitude, longitude]);
            user = newUserResult.rows[0];
            res.status(201).json({ success: true, message: 'Registration successful!', user: user });
        }
    } catch (error) {
        console.error('Patient login/registration error:', error);
        res.status(500).json({ success: false, message: 'Database error during authentication.' });
    }
});

// ==========================================================================
//  HOSPITAL AUTHENTICATION
// ==========================================================================
app.post('/api/server/hospital-register', async (req, res) => {
    const { hospitalName, address, pincode, phoneNumber, password } = req.body;
    if (!hospitalName || !pincode || !phoneNumber || !password) {
        return res.status(400).json({ success: false, message: 'All fields are required.' });
    }
    try {
        const existing = await pool.query('SELECT * FROM hospitals WHERE phone_number = $1', [phoneNumber]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ success: false, message: 'Phone number already registered.' });
        }
        const lastIdRes = await pool.query("SELECT hospital_id FROM hospitals ORDER BY hospital_id DESC LIMIT 1");
        const newIdNum = lastIdRes.rows.length ? parseInt(lastIdRes.rows[0].hospital_id.replace('HOS','')) + 1 : 101;
        const newId = `HOS${newIdNum}`;
        const result = await pool.query(
            'INSERT INTO hospitals (hospital_id, hospital_name, address, pincode, phone_number, password_hash, blood_inventory) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING hospital_id',
            [newId, hospitalName, address, pincode, phoneNumber, password, '{}']
        );
        res.status(201).json({ success: true, hospitalId: result.rows[0].hospital_id });
    } catch (err) {
        console.error("Hospital Registration Error:", err);
        res.status(500).json({ success: false, message: 'Server error during registration.' });
    }
});

app.post('/api/server/hospital-login', async (req, res) => {
    const { hospitalId, password } = req.body;
    if (!hospitalId || !password) {
        return res.status(400).json({ success: false, message: 'Hospital ID and password are required.' });
    }
    try {
        const result = await pool.query('SELECT * FROM hospitals WHERE hospital_id = $1', [hospitalId.toUpperCase()]);
        const hospital = result.rows[0];
        if (!hospital) {
            return res.status(404).json({ success: false, message: 'Hospital ID not found.' });
        }
        if (password === hospital.password_hash) {
            const { password_hash, ...hospitalData } = hospital;
            res.status(200).json({ success: true, hospital: hospitalData });
        } else {
            res.status(401).json({ success: false, message: 'Invalid password.' });
        }
    } catch (err) {
        console.error("Hospital Login Error:", err);
        res.status(500).json({ success: false, message: 'Server error during login.' });
    }
});

// ==========================================================================
//  HOSPITAL DASHBOARD - NEW FEATURES
// ==========================================================================
app.post('/api/server/hospital-sos', async (req, res) => {
    const { hospitalId, component, bloodType, units, urgency } = req.body;
    if (!hospitalId || !component || !bloodType || !units || !urgency) {
        return res.status(400).json({ success: false, message: 'Missing required SOS fields.' });
    }
    try {
        const requestQuery = `
            INSERT INTO blood_requests (creator_hospital_id, blood_type_needed, component_needed, urgency, status)
            VALUES ($1, $2, $3, $4, 'active') RETURNING request_id;`;
        const newRequest = await pool.query(requestQuery, [hospitalId, bloodType, component, urgency]);
        res.status(201).json({ success: true, message: 'SOS broadcasted!', requestId: newRequest.rows[0].request_id });
    } catch (error) {
        console.error('Hospital SOS error:', error);
        res.status(500).json({ success: false, message: 'Server error during SOS broadcast.' });
    }
});

app.post('/api/server/update-inventory', async (req, res) => {
    const { hospitalId, inventory } = req.body;
    if (!hospitalId || !inventory) {
        return res.status(400).json({ success: false, message: 'Missing hospital ID or inventory data.' });
    }
    try {
        await pool.query('UPDATE hospitals SET blood_inventory = $1 WHERE hospital_id = $2', [inventory, hospitalId]);
        res.status(200).json({ success: true, message: 'Stock levels updated.' });
    } catch (error) {
        console.error('Inventory update error:', error);
        res.status(500).json({ success: false, message: 'Database error while updating inventory.' });
    }
});

app.post('/api/server/donor-checkin', async (req, res) => {
    const { qrToken } = req.body;
    if (!qrToken) {
        return res.status(400).json({ success: false, message: 'QR Token is required.' });
    }
    try {
        const result = await pool.query(
            "UPDATE donations SET status = 'arrived' WHERE qr_data = $1 AND status = 'scheduled' RETURNING donation_id, donor_id",
            [qrToken]
        );
        if (result.rows.length > 0) {
            res.status(200).json({ success: true, message: 'Donor checked in successfully!', donation: result.rows[0] });
        } else {
            res.status(404).json({ success: false, message: 'Invalid or already used token.' });
        }
    } catch (error) {
        console.error('Check-in error:', error);
        res.status(500).json({ success: false, message: 'Server error during check-in.' });
    }
});

app.get('/api/server/playbooks/:hospitalId', async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM playbooks WHERE hospital_id = $1 ORDER BY updated_at DESC", [req.params.hospitalId]);
        res.status(200).json(result.rows);
    } catch (error) {
        res.status(500).json([]);
    }
});

app.post('/api/server/playbooks', async (req, res) => {
    const { hospitalId, title, content } = req.body;
    try {
        const result = await pool.query(
            "INSERT INTO playbooks (hospital_id, title, content) VALUES ($1, $2, $3) RETURNING *",
            [hospitalId, title, content]
        );
        res.status(201).json({ success: true, playbook: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to save playbook.' });
    }
});

app.get('/api/server/reports/:hospitalId', async (req, res) => {
    const { hospitalId } = req.params;
    try {
        const reportQuery = `
            SELECT status, COUNT(request_id) as count
            FROM blood_requests
            WHERE creator_hospital_id = $1
            GROUP BY status;`;
        const result = await pool.query(reportQuery, [hospitalId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Report generation error:', error);
        res.status(500).json({ message: 'Failed to generate report.' });
    }
});

// ==========================================================================
//  SHARED FUNCTIONALITY (SOS & DASHBOARDS)
// ==========================================================================

// --- START: PUSHER INTEGRATION ---
// This endpoint is completely replaced with the new real-time logic.
app.post('/api/server/request-blood', async (req, res) => {
    const { patientId, bloodType, pincode, latitude, longitude } = req.body;

    if (!patientId || !bloodType || !latitude || !longitude) {
        return res.status(400).json({ success: false, message: 'Missing required fields (ID, blood type, and location).' });
    }

    try {
        // --- Phase 1: Search for Hospitals (15 km radius) ---
        const allHospitals = await pool.query('SELECT hospital_id, hospital_name, latitude, longitude, blood_inventory FROM hospitals');
        
        const suitableHospitals = allHospitals.rows.filter(hospital => {
            const distance = calculateDistance(latitude, longitude, hospital.latitude, hospital.longitude);
            const hasStock = hospital.blood_inventory && hospital.blood_inventory[bloodType] > 0;
            return distance <= 15 && hasStock;
        });

        if (suitableHospitals.length > 0) {
            console.log(`Found ${suitableHospitals.length} suitable hospital(s). Notifying via Pusher.`);
            for (const hospital of suitableHospitals) {
                const distance = calculateDistance(latitude, longitude, hospital.latitude, hospital.longitude);
                const payload = {
                    patientId: patientId,
                    bloodType: bloodType,
                    distance: distance,
                    message: `Emergency request for ${bloodType} from a patient ~${distance.toFixed(1)}km away.`
                };
                // Channel name is specific to each hospital (e.g., 'hospital-HOS101')
                await pusher.trigger(`hospital-${hospital.hospital_id}`, 'sos-request', payload);
            }
            return res.status(200).json({ success: true, message: 'SOS Alert sent to nearby hospitals!' });
        }

        // --- Phase 2: Search for Donors (30 km radius) if no hospitals found ---
        console.log('No suitable hospitals found. Searching for donors...');
        const allDonors = await pool.query(
            "SELECT user_id, full_name, latitude, longitude FROM users WHERE role = 'donor' AND blood_type = $1",
            [bloodType]
        );

        const suitableDonors = allDonors.rows.filter(donor => {
            const distance = calculateDistance(latitude, longitude, donor.latitude, donor.longitude);
            return distance <= 30; 
        });

        if (suitableDonors.length > 0) {
            console.log(`Found ${suitableDonors.length} suitable donor(s). Notifying via Pusher.`);
            for (const donor of suitableDonors) {
                const distance = calculateDistance(latitude, longitude, donor.latitude, donor.longitude);
                const payload = {
                    patientId: patientId,
                    bloodType: bloodType,
                    distance: distance,
                    message: `A patient ~${distance.toFixed(1)}km away needs your help with a ${bloodType} blood donation.`
                };
                // Channel name is specific to each donor (e.g., 'donor-123')
                await pusher.trigger(`donor-${donor.user_id}`, 'sos-request', payload);
            }
            return res.status(200).json({ success: true, message: 'No hospitals with stock found. Alerting nearby donors!' });
        }

        // --- Phase 3: No one found ---
        console.log('No suitable hospitals or donors found.');
        return res.status(404).json({ success: false, message: 'Could not find any suitable hospitals or donors nearby.' });

    } catch (error) {
        console.error('Error in /request-blood:', error);
        res.status(500).json({ success: false, message: 'An internal server error occurred.' });
    }
});
// --- END: PUSHER INTEGRATION ---

app.get('/api/server/sos-alerts/:hospitalId', async (req, res) => {
    const { hospitalId } = req.params;
    const lastTimestamp = req.query.lastTimestamp || '1970-01-01T00:00:00.000Z';
    try {
        const sosQuery = `
            SELECT br.request_id, br.blood_type_needed, br.pincode, br.created_at
            FROM blood_requests br
            JOIN sos_notifications sn ON br.request_id = sn.request_id
            WHERE sn.hospital_id = $1 AND br.status = 'active' AND br.created_at > $2
            ORDER BY br.created_at ASC;`;
        const sosResult = await pool.query(sosQuery, [hospitalId.toUpperCase(), lastTimestamp]);
        res.status(200).json(sosResult.rows);
    } catch (error) {
        console.error(`Error fetching SOS alerts for ${hospitalId}:`, error);
        res.status(500).json({ message: 'Server error fetching alerts.' });
    }
});

app.get('/api/server/requests/history/:patientId', async (req, res) => {
    const { patientId } = req.params;
    try {
        const result = await pool.query(
            `SELECT request_id, blood_type_needed, pincode, status, created_at
             FROM blood_requests WHERE patient_id = $1 ORDER BY created_at DESC`,
            [patientId]
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching request history:', error);
        res.status(500).json([]);
    }
});


// ==========================================================================
//  DONOR OTP AUTHENTICATION (ALERT-BASED)
// ==========================================================================

app.post('/api/server/donor/generate-otp', async (req, res) => {
    const { phoneNumber } = req.body;
    try {
        const userCheck = await pool.query("SELECT user_id FROM users WHERE phone_number = $1 AND role = 'donor'", [phoneNumber]);
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Not a registered donor. Please register first.' });
        }
        
        const otp = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit OTP
        otpStore[phoneNumber] = { otp, expiry: Date.now() + 300000 }; // OTP valid for 5 mins
        console.log(`Generated Login OTP for donor ${phoneNumber}: ${otp}`);
        
        res.status(200).json({ success: true, message: 'OTP generated successfully.', otp });
    } catch (error) {
        console.error('Donor login OTP error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

app.post('/api/server/donor/login', async (req, res) => {
    const { phoneNumber, otp } = req.body;
    const storedOtp = otpStore[phoneNumber];

    if (storedOtp && storedOtp.otp === otp && Date.now() < storedOtp.expiry) {
        try {
            const result = await pool.query("SELECT user_id, full_name, phone_number, pincode, blood_type, role FROM users WHERE phone_number = $1 AND role = 'donor'", [phoneNumber]);
            const user = result.rows[0];
            
            delete otpStore[phoneNumber]; 
            res.status(200).json({ success: true, message: 'Login successful!', user: user });
        } catch (error) {
            console.error('Database error during donor login:', error);
            res.status(500).json({ success: false, message: 'Database error during login.' });
        }
    } else {
        res.status(401).json({ success: false, message: 'Invalid or expired OTP.' });
    }
});

app.post('/api/server/donor/register-request', async (req, res) => {
    const { phoneNumber } = req.body;
    try {
        const userExists = await pool.query('SELECT user_id FROM users WHERE phone_number = $1', [phoneNumber]);
        if (userExists.rows.length > 0) {
            return res.status(409).json({ success: false, message: 'This phone number is already registered.' });
        }
        
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        otpStore[phoneNumber] = { otp, expiry: Date.now() + 300000 };
        console.log(`Generated Register OTP for donor ${phoneNumber}: ${otp}`);
        
        res.status(200).json({ success: true, message: 'OTP sent for registration.', otp });
    } catch (error) {
        console.error('Donor registration request error:', error);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

app.post('/api/server/donor/register-confirm', async (req, res) => {
    const { fullName, phoneNumber, pincode, bloodType, otp } = req.body;
    const storedOtp = otpStore[phoneNumber];
    
    if (storedOtp && storedOtp.otp === otp && Date.now() < storedOtp.expiry) {
        try {
            const newUserQuery = `
                INSERT INTO users (full_name, phone_number, pincode, blood_type, role)
                VALUES ($1, $2, $3, $4, 'donor') RETURNING user_id;
            `;
            await pool.query(newUserQuery, [fullName, phoneNumber, pincode, bloodType]);
            
            delete otpStore[phoneNumber];
            res.status(201).json({ success: true, message: 'Registration successful!' });
        } catch (error) {
            console.error('Donor registration confirmation error:', error);
            res.status(500).json({ success: false, message: 'Database error during registration.' });
        }
    } else {
        res.status(400).json({ success: false, message: 'Invalid or expired OTP.' });
    }
});

// ==========================================================================
//  DONOR DASHBOARD FUNCTIONALITY (NEW SECTION)
// ==========================================================================

app.get('/api/hospitals/nearest', (req, res) => {
    const { lat, lon, bloodType } = req.query;
    if (!lat || !lon) {
        return res.status(400).json({ success: false, message: 'Current location is required.' });
    }

    let closestHospital = null;
    let minDistance = Infinity;

    hospitalsDB.forEach(hospital => {
        const needsBlood = hospital.stock[bloodType] !== undefined && hospital.stock[bloodType] < 5;
        if (needsBlood) {
            const distance = calculateDistance(lat, lon, hospital.location.lat, hospital.location.lon);
            if (distance < minDistance) {
                minDistance = distance;
                closestHospital = hospital;
            }
        }
    });

    if (closestHospital) {
        res.json({ success: true, hospital: { ...closestHospital, distance: minDistance } });
    } else {
        res.status(404).json({ success: false, message: 'No hospitals urgently need your blood type nearby.' });
    }
});

app.post('/api/donor/schedule-donation', (req, res) => {
    const { pincode, bloodType } = req.body;
    const suitableHospital = hospitalsDB.find(h => h.pincode === pincode);

    if (suitableHospital) {
        console.log(`Donation scheduled for ${bloodType} at ${suitableHospital.name}`);
        res.json({ success: true, hospital: suitableHospital });
    } else {
        res.status(404).json({ success: false, message: `No hospitals found in pincode ${pincode}.` });
    }
});

app.get('/api/donor/score/:userId', (req, res) => {
    const { userId } = req.params;
    const donor = donorsDB.find(d => d.userId === userId);
    if (donor) {
        res.json({ success: true, score: donor.reliabilityScore });
    } else {
        res.status(404).json({ success: false, message: 'Donor not found.' });
    }
});

// ==========================================================================
//  HEALTH CHECK - FOR DEBUGGING
// ==========================================================================
app.get('/api/server/health', (req, res) => {
    res.status(200).json({ status: 'ok', message: 'Server is running' });
});

// ==========================================================================
//  EXPORT THE APP FOR VERCEL (UPDATED)
// ==========================================================================
module.exports = app;
