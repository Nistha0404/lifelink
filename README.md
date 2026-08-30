# LifeLink - Blood Donation & Emergency SOS Platform

A modern web application connecting blood donors, patients, hospitals, and volunteers in real-time.

## Project Structure

```
/
├── frontend/
│   ├── pages/                  # HTML UI Pages
│   │   ├── index.html          # Landing page
│   │   ├── patient-login.html  # Patient auth & OTP
│   │   ├── patient-dashboard.html # Emergency SOS & Status
│   │   ├── donor-login.html    # Donor auth
│   │   ├── donor-dashboard.html# Donor portal
│   │   ├── donor-questionnaire.html # Eligibility screening
│   │   ├── hospital-login.html # Hospital portal auth
│   │   ├── hospital-dashboard.html # Hospital SOS response
│   │   ├── volunteer-login.html# Volunteer auth
│   │   ├── volunteer-dashboard.html # Community drives
│   │   ├── admin-login.html    # Admin portal auth
│   │   ├── admin-dashboard.html# Platform administration
│   │   └── facts.html          # Educational resources
│   ├── css/
│   │   └── style.css           # Global design system & component styles
│   ├── js/
│   │   ├── lifelink-api.js     # Centralized API integration module
│   │   ├── donor-dashboard.js  # Donor dashboard module
│   │   ├── geolocation.js      # Robust HTML5 geolocation handler
│   │   ├── hospital-dashboard.js# Hospital management module
│   │   └── hospital-register.js# Hospital onboarding module
│   └── assets/                 # Logotype & image resources
├── backend/
│   └── server.js               # Node.js/Express REST API & Static Server
├── .gitignore                  # Git ignore rules
├── package.json                # Project dependencies & scripts
├── vercel.json                 # Vercel deployment configuration
└── README.md                   # Project documentation
```

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Set Environment Variables
Configure the following variables in your environment or `.env` file:
```env
POSTGRES_URL=your_postgresql_connection_string
FAST2SMS_API_KEY=your_fast2sms_api_key
OPENCAGE_API_KEY=your_opencage_api_key
PORT=3000
```

### 3. Run the Application
```bash
npm start
```
Or for development:
```bash
npm run dev
```

Access the application in your browser at `http://localhost:3000`.

## Architecture Notes
- **Frontend**: Responsive Vanilla HTML5/CSS3/JavaScript web components.
- **Backend**: Express.js REST API providing database operations (PostgreSQL `pg` pool), geolocation proximity algorithms, and fast OTP dispatch.
- **Deployment**: Serverless-ready deployment configured via `vercel.json` rewriting API routes to `backend/server.js`.
