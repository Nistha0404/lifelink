/**
 * LifeLink API Client
 * Central API integration for all frontend pages
 * Handles all backend communication with popup alerts
 */

const LifeLinkAPI = {
  baseURL: '/api/server',
  
  /**
   * Generic fetch wrapper with error handling
   */
  async request(endpoint, options = {}) {
    try {
      const response = await fetch(this.baseURL + endpoint, {
        headers: {
          'Content-Type': 'application/json',
          ...options.headers
        },
        ...options
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.message || 'Request failed');
      }
      
      return data;
    } catch (error) {
      console.error('API Error:', error);
      throw error;
    }
  },

  // ============================================================================
  // PATIENT APIs
  // ============================================================================
  
  patient: {
    /**
     * Send OTP to patient phone
     */
    async sendOTP(phoneNumber) {
      const result = await LifeLinkAPI.request('/send-otp', {
        method: 'POST',
        body: JSON.stringify({ phoneNumber })
      });
      
      // Show OTP in popup
      if (result.success && result.otp) {
        alert(`🔐 Your OTP is: ${result.otp}\n\n(In production, this will be sent via SMS)`);
      }
      
      return result;
    },
    
    /**
     * Login or register patient
     */
    async login(phoneNumber, fullName, pincode, otp) {
      return await LifeLinkAPI.request('/patient-login', {
        method: 'POST',
        body: JSON.stringify({ phoneNumber, fullName, pincode, otp })
      });
    },
    
    /**
     * Send SOS blood request with geolocation
     */
    async sendSOS(patientId, bloodType, pincode) {
      return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
          reject(new Error('Geolocation not supported'));
          return;
        }
        
        navigator.geolocation.getCurrentPosition(
          async (position) => {
            try {
              const result = await LifeLinkAPI.request('/request-blood', {
                method: 'POST',
                body: JSON.stringify({
                  patientId,
                  bloodType,
                  pincode,
                  latitude: position.coords.latitude,
                  longitude: position.coords.longitude
                })
              });
              
              // Show success popup
              if (result.success) {
                alert(`✅ SOS Alert Sent!\n\n` +
                      `Hospitals notified: ${result.message}\n` +
                      `Your token: ${result.patient_token}\n\n` +
                      `Keep this token safe!`);
              }
              
              resolve(result);
            } catch (error) {
              reject(error);
            }
          },
          (error) => {
            let message = 'Location access denied. ';
            switch(error.code) {
              case error.PERMISSION_DENIED:
                message += 'Please allow location access.';
                break;
              case error.POSITION_UNAVAILABLE:
                message += 'Location unavailable.';
                break;
              case error.TIMEOUT:
                message += 'Location request timed out.';
                break;
            }
            reject(new Error(message));
          },
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
      });
    },
    
    /**
     * Get request status
     */
    async getStatus(requestId) {
      return await LifeLinkAPI.request(`/request-status/${requestId}`, {
        method: 'GET'
      });
    },
    
    /**
     * Get request history
     */
    async getHistory(patientId) {
      const result = await LifeLinkAPI.request(`/requests/history/${patientId}`, {
        method: 'GET'
      });
      return result.history || [];
    }
  },

  // ============================================================================
  // HOSPITAL APIs
  // ============================================================================
  
  hospital: {
    /**
     * Hospital login
     */
    async login(phoneNumber, password) {
      return await LifeLinkAPI.request('/hospital-login', {
        method: 'POST',
        body: JSON.stringify({ phoneNumber, password })
      });
    },
    
    /**
     * Get SOS alerts for hospital
     */
    async getAlerts(hospitalId) {
      const result = await LifeLinkAPI.request(`/sos-alerts/${hospitalId}`, {
        method: 'GET'
      });
      return result.alerts || [];
    },
    
    /**
     * Accept or reject SOS request
     */
    async respondToSOS(requestId, hospitalId, status) {
      const result = await LifeLinkAPI.request('/hospital-response', {
        method: 'POST',
        body: JSON.stringify({ requestId, hospitalId, status })
      });
      
      // Show popup confirmation
      if (result.success) {
        if (status === 'accepted' || status === 'Accepted') {
          alert(`✅ Request Accepted!\n\n${result.message}\nPatient will be notified.`);
        } else {
          alert(`❌ Request Rejected\n\n${result.message}`);
        }
      }
      
      return result;
    },
    
    /**
     * Update hospital inventory
     */
    async updateInventory(hospitalId, stock) {
      return await LifeLinkAPI.request('/update-inventory', {
        method: 'POST',
        body: JSON.stringify({ hospitalId, stock })
      });
    },
    
    /**
     * Verify patient or donor token
     */
    async verifyToken(token) {
      return await LifeLinkAPI.request('/verify-token', {
        method: 'POST',
        body: JSON.stringify({ token })
      });
    }
  },

  // ============================================================================
  // DONOR APIs
  // ============================================================================
  
  donor: {
    /**
     * Send OTP to donor phone
     */
    async sendOTP(phoneNumber) {
      const result = await LifeLinkAPI.request('/donor/send-otp', {
        method: 'POST',
        body: JSON.stringify({ phoneNumber })
      });
      
      // Show OTP in popup
      if (result.success && result.otp) {
        alert(`🔐 Your OTP is: ${result.otp}\n\n(In production, this will be sent via SMS)`);
      }
      
      return result;
    },
    
    /**
     * Login or register donor
     */
    async login(phoneNumber, fullName, bloodType, pincode, otp) {
      return await LifeLinkAPI.request('/donor-login', {
        method: 'POST',
        body: JSON.stringify({ phoneNumber, fullName, bloodType, pincode, otp })
      });
    },
    
    /**
     * Get escalated SOS alerts for donor
     */
    async getAlerts(donorId) {
      const result = await LifeLinkAPI.request(`/donor/sos-alerts/${donorId}`, {
        method: 'GET'
      });
      
      // Show popup if there are new urgent alerts
      if (result.success && result.alerts && result.alerts.length > 0) {
        const firstAlert = result.alerts[0];
        const shouldNotify = sessionStorage.getItem('lastAlertId') !== String(firstAlert.request_id);
        
        if (shouldNotify) {
          alert(`🚨 URGENT BLOOD NEEDED!\n\n` +
                `Blood Type: ${firstAlert.blood_type_needed}\n` +
                `Distance: ${firstAlert.distance_km || '?'} km\n\n` +
                `Check your dashboard to accept!`);
          sessionStorage.setItem('lastAlertId', firstAlert.request_id);
        }
      }
      
      return result.alerts || [];
    },
    
    /**
     * Accept SOS alert with geolocation
     */
    async acceptSOS(donorId, requestId) {
      return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
          reject(new Error('Geolocation not supported'));
          return;
        }
        
        navigator.geolocation.getCurrentPosition(
          async (position) => {
            try {
              const result = await LifeLinkAPI.request('/donor/accept-sos', {
                method: 'POST',
                body: JSON.stringify({
                  donorId,
                  requestId,
                  donorLatitude: position.coords.latitude,
                  donorLongitude: position.coords.longitude
                })
              });
              
              // Show success popup with details
              if (result.success) {
                alert(`✅ Thank You for Accepting!\n\n` +
                      `Your token: ${result.donor_token}\n` +
                      `Hospital: ${result.hospital.name}\n` +
                      `Address: ${result.hospital.address}\n` +
                      `Pincode: ${result.hospital.pincode}\n\n` +
                      `Please proceed to the hospital.`);
              }
              
              resolve(result);
            } catch (error) {
              reject(error);
            }
          },
          (error) => {
            reject(new Error('Location access required to accept request.'));
          },
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
      });
    },
    
    /**
     * Get donor's commitments
     */
    async getCommitments(donorId) {
      const result = await LifeLinkAPI.request(`/donor/commitments/${donorId}`, {
        method: 'GET'
      });
      return result.commitments || [];
    }
,
    
    /**
     * Get nearby hospitals for scheduling
     */
    async getNearbyHospitals(donorId, radius = 50) {
      const result = await LifeLinkAPI.request(`/donor/nearby-hospitals/${donorId}?radius=${radius}`, {
        method: 'GET'
      });
      return result;
    },
    
    /**
     * Schedule a donation appointment
     */
    async scheduleDonation(donorId, hospitalId, scheduledDate, donationType = 'whole_blood') {
      const result = await LifeLinkAPI.request('/donor/schedule-donation', {
        method: 'POST',
        body: JSON.stringify({ donorId, hospitalId, scheduledDate, donationType })
      });
      
      // Show success popup
      if (result.success) {
        alert(`✅ Donation Scheduled!\n\n` +
              `Hospital: ${result.appointment.hospital}\n` +
              `Date: ${new Date(scheduledDate).toLocaleDateString()}\n` +
              `Token: ${result.appointment.token}\n\n` +
              `Please save your token!`);
      }
      
      return result;
    }
  },

  // ============================================================================
  // VOLUNTEER APIs
  // ============================================================================
  
  volunteer: {
    /**
     * Send OTP to volunteer phone
     */
    async sendOTP(phoneNumber) {
      const result = await LifeLinkAPI.request('/volunteer/send-otp', {
        method: 'POST',
        body: JSON.stringify({ phoneNumber })
      });
      
      // Show OTP in popup
      if (result.success && result.otp) {
        alert(`🔐 Your OTP is: ${result.otp}\n\n(In production, this will be sent via SMS)`);
      }
      
      return result;
    },
    
    /**
     * Login or register volunteer/NGO
     */
    async login(phoneNumber, fullName, ngoName, registrationId, type, otp) {
      return await LifeLinkAPI.request('/volunteer-login', {
        method: 'POST',
        body: JSON.stringify({ phoneNumber, fullName, ngoName, registrationId, type, otp })
      });
    },
    
    /**
     * Get available drives
     */
    async getDrivesAvailable() {
      const result = await LifeLinkAPI.request('/drives-available', {
        method: 'GET'
      }, '/api/volunteer');
      return result.drives || [];
    },
    
    /**
     * Get roles for specific drive
     */
    async getDriveRoles(driveId) {
      const result = await LifeLinkAPI.request(`/drive-roles/${driveId}`, {
        method: 'GET'
      }, '/api/volunteer');
      return result.roles || [];
    },
    
    /**
     * Create new drive
     */
    async createDrive(organizerId, driveName, location, startDate, endDate, startTime, endTime, targetDonors, roles) {
      return await LifeLinkAPI.request('/drive-create', {
        method: 'POST',
        body: JSON.stringify({ organizerId, driveName, location, startDate, endDate, startTime, endTime, targetDonors, roles })
      }, '/api/volunteer');
    },
    
    /**
     * Sign up for drive role
     */
    async signUpForDrive(volunteerId, roleId, shiftStart, shiftEnd) {
      return await LifeLinkAPI.request('/drive-signup', {
        method: 'POST',
        body: JSON.stringify({ volunteerId, roleId, shiftStart, shiftEnd })
      }, '/api/volunteer');
    },
    
    /**
     * Get volunteer's assignments
     */
    async getMyAssignments(volunteerId) {
      const result = await LifeLinkAPI.request(`/my-assignments/${volunteerId}`, {
        method: 'GET'
      }, '/api/volunteer');
      return result.assignments || [];
    }
  },

  // ============================================================================
  // ADMIN APIs
  // ============================================================================
  
  admin: {
    /**
     * Admin login
     */
    async login(username, password) {
      return await LifeLinkAPI.request('/admin-login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
    }
  },

  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================
  
  /**
   * Get current user from session storage
   */
  getCurrentUser() {
    const userStr = sessionStorage.getItem('currentUser');
    return userStr ? JSON.parse(userStr) : null;
  },
  
  /**
   * Save current user to session storage
   */
  setCurrentUser(user) {
    sessionStorage.setItem('currentUser', JSON.stringify(user));
  },
  
  /**
   * Clear current user (logout)
   */
  logout() {
    sessionStorage.removeItem('currentUser');
    sessionStorage.removeItem('lastAlertId');
    window.location.href = 'index.html';
  },
  
  /**
   * Check if user is logged in
   */
  isLoggedIn() {
    return this.getCurrentUser() !== null;
  },
  
  /**
   * Redirect if not logged in
   */
  requireAuth(loginPage = 'patient-login.html') {
    if (!this.isLoggedIn()) {
      window.location.href = loginPage;
    }
  }
};

// Make it available globally
window.LifeLinkAPI = LifeLinkAPI;

// Auto-logout on session end
window.addEventListener('beforeunload', () => {
  // Optional: Clear session on tab close
  // sessionStorage.clear();
});

console.log('✅ LifeLink API Client loaded successfully');