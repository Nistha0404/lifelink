document.addEventListener('DOMContentLoaded', () => {
  let currentHospital = null;
  let sosPollInterval; // Timer for polling SOS
  let sosTimers = {}; // Stores all active countdown intervals

  // --- Elements ---
  const welcomeMessage = document.getElementById('welcome-message');
  const logoutBtn = document.getElementById('logoutBtn');

  // SOS
  const hospitalSosForm = document.getElementById('hospital-sos-form');
  const hospitalSosMessage = document.getElementById('hospital-sos-message');
  const liveSosList = document.getElementById('live-sos-list');

  // Stock Lite
  const inventoryContainer = document.getElementById('inventory-container');
  const saveInventoryBtn = document.getElementById('save-inventory-btn');
  const inventoryMessage = document.getElementById('inventory-message');

  // Verification
  const verifyInput = document.getElementById('verify-token-input');
  const verifyBtn = document.getElementById('verify-btn');
  const verifyMsg = document.getElementById('verify-message');
  const verifyResults = document.getElementById('verify-results');
  
  // Donor Log
  const donorLogList = document.getElementById('donor-log-list');
  const donorLogPlaceholder = document.getElementById('donor-log-placeholder');
  const refreshDonorLogBtn = document.getElementById('refresh-donor-log-btn');


  // --- Initialization ---
  function initializeDashboard() {
    const s = sessionStorage.getItem('currentHospital');
    if (!s) { window.location.href = 'hospital-login.html'; return; }
    currentHospital = JSON.parse(s);
    welcomeMessage.textContent = `Welcome, ${currentHospital.hospital_name}`;
    
    renderStockLiteControls();
    startPollingForSOS(); // <-- MODIFIED to start new polling logic
    fetchDonorAppointments(); // This is your existing function
  }

  // --- SOS Broadcast (Your existing code) ---
  hospitalSosForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      hospitalId: currentHospital.hospital_id,
      component: document.getElementById('sos-component').value,
      bloodType: document.getElementById('sos-blood-type').value,
      units: document.getElementById('sos-units').value,
      urgency: document.getElementById('sos-urgency').value,
    };
    try {
      const res = await fetch('/api/server/hospital-sos', {
        method: 'POST', headers: { 'Content-Type':'application/json' },
        body: JSON.stringify(payload)
      });
      const out = await res.json();
      displayMessage(hospitalSosMessage, out.message, out.success);
    } catch (err) {
      console.error(err);
      displayMessage(hospitalSosMessage, 'Server connection error.', false);
    }
  });

  // --- Stock Lite (Your existing code) ---
  function renderStockLiteControls() {
    inventoryContainer.innerHTML = '';
    const bloodGroups = ["A+","A-","B+","B-","AB+","AB-","O+","O-"];
    const inv = currentHospital.blood_inventory || {};
    for (const type of bloodGroups) {
      const item = inv[type] || { units: 0, confidence: 'Low' };
      const html = `
        <div class="inventory-item">
          <label>${type}</label>
          <input type="number" data-blood-type="${type}" class="stock-units" value="${item.units}" min="0">
          <select data-blood-type="${type}" class="stock-confidence">
            <option value="High" ${item.confidence === 'High' ? 'selected' : ''}>High</option>
            <option value="Medium" ${item.confidence === 'Medium' ? 'selected' : ''}>Medium</option>
            <option value="Low" ${item.confidence === 'Low' ? 'selected' : ''}>Low</option>
          </select>
        </div>`;
      inventoryContainer.insertAdjacentHTML('beforeend', html);
    }
  }

  saveInventoryBtn.addEventListener('click', async () => {
    const updated = {};
    document.querySelectorAll('.inventory-item').forEach(item => {
      const unitsEl = item.querySelector('.stock-units');
      const confEl = item.querySelector('.stock-confidence');
      const type = unitsEl.dataset.bloodType;
      updated[type] = {
        units: parseInt(unitsEl.value, 10) || 0,
        confidence: confEl.value,
        timestamp: new Date().toISOString()
      };
    });
    try {
      const res = await fetch('/api/server/update-inventory', {
        method:'POST', headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ hospitalId: currentHospital.hospital_id, inventory: updated })
      });
      const out = await res.json();
      if (out.success) {
        currentHospital.blood_inventory = updated;
        sessionStorage.setItem('currentHospital', JSON.stringify(currentHospital));
      }
      displayMessage(inventoryMessage, out.message, out.success);
    } catch (err) {
      console.error(err);
      displayMessage(inventoryMessage, 'Server connection error.', false);
    }
  });

  // --- Unified Token Verification (Your existing code) ---
  verifyInput.addEventListener('input', () => {
    verifyInput.value = (verifyInput.value || '').replace(/\D/g, '').slice(0, 4);
    clearVerifyUI();
  });
  verifyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); verifyBtn.click(); }
  });
  verifyBtn.addEventListener('click', async () => {
    const token = (verifyInput.value || '').trim();
    if (!/^\d{4}$/.test(token)) {
      showVerifyMsg('Please enter a valid 4-digit token.', false); return;
    }
    try {
      showVerifyMsg('Verifying…', true);
      const res = await fetch('/api/server/verify-token', {
        method:'POST', headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ token })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        showVerifyMsg(data.message || 'Token not found.', false);
        verifyResults.innerHTML = ''; return;
      }
      renderVerificationResult(data);
      showVerifyMsg('Verified', true);
    } catch (err) {
      console.error(err);
      showVerifyMsg('Server error while verifying.', false);
      verifyResults.innerHTML = '';
    }
  });
  function qrFor(obj) { /* ... (your existing function) ... */ }
  function renderVerificationResult(data) { /* ... (your existing function) ... */ }
  function clearVerifyUI() { /* ... (your existing function) ... */ }
  function showVerifyMsg(msg, ok) { /* ... (your existing function) ... */ }
  function esc(s) { /* ... (your existing function) ... */ }


  // ===================================================================
  // --- NEW: LIVE SOS - MODIFIED POLLING & NEW HANDLERS ---
  // ===================================================================

  /**
   * NEW: Event Delegation for Accept/Reject buttons
   */
  liveSosList.addEventListener('click', (e) => {
    const target = e.target;
    const sosItem = target.closest('.sos-item'); // Changed from .sos-request-item

    if (!sosItem || sosItem.dataset.status === 'closed') return;

    const requestId = sosItem.dataset.requestId;

    if (target.classList.contains('accept-btn')) {
      handleHospitalResponse(requestId, 'accept', sosItem);
    } else if (target.classList.contains('reject-btn')) {
      handleHospitalResponse(requestId, 'reject', sosItem);
    }
  });

  /**
   * NEW: Sends the hospital's response (Accept/Reject) to the server
   */
  async function handleHospitalResponse(requestId, response, itemElement) {
    itemElement.querySelectorAll('button').forEach(b => b.disabled = true);

    try {
      const res = await fetch('/api/server/hospital-response', { // <-- NEW ENDPOINT
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: requestId,
          hospitalId: currentHospital.hospital_id,
          response: response // 'accept' or 'reject'
        })
      });
      const result = await res.json();

      if (result.success) {
        showResponseUI(itemElement, response);
      } else {
        alert(`Error: ${result.message}`);
        itemElement.querySelectorAll('button').forEach(b => b.disabled = false);
      }
    } catch (err) {
      console.error('Response Error:', err);
      alert('Could not connect to server.');
      itemElement.querySelectorAll('button').forEach(b => b.disabled = false);
    }
  }
  
  /**
   * NEW: Updates the card UI after a response
   */
  function showResponseUI(itemElement, response) {
    itemElement.dataset.status = 'closed';
    const requestId = itemElement.dataset.requestId;
    if (sosTimers[requestId]) {
      clearInterval(sosTimers[requestId]);
      delete sosTimers[requestId];
    }
    
    // Clear actions and timer, show message
    itemElement.querySelector('.sos-actions').style.display = 'none';
    itemElement.querySelector('.sos-timer-wrap').style.display = 'none';
    
    const message = document.createElement('div');
    message.className = `sos-response-message ${response === 'accept' ? 'accepted' : 'rejected'}`;
    message.textContent = response === 'accept' ? 'REQUEST ACCEPTED' : 'Request Rejected';
    itemElement.appendChild(message);
  }

  /**
   * MODIFIED: Starts the polling loop
   */
  async function startPollingForSOS() {
    if (!currentHospital || !currentHospital.hospital_id) {
      console.log("No hospital info, can't start monitor.");
      return;
    }
    if (sosPollInterval) clearInterval(sosPollInterval);
    
    await fetchSosAlerts(); // Fetch immediately
    sosPollInterval = setInterval(fetchSosAlerts, 15000); // Then poll
  }

  /**
   * MODIFIED: Fetches alerts and *diffs* the list
   * This now adds new alerts and removes old ones without
   * destroying active timers.
   */
  async function fetchSosAlerts() {
    try {
      const response = await fetch(`/api/server/sos-alerts/${currentHospital.hospital_id}`);
      const requests = await response.json(); // Expects an array of alert objects

      // Get all request IDs currently displayed
      const currentIds = new Set([...liveSosList.querySelectorAll('.sos-item')].map(li => li.dataset.requestId));
      const serverIds = new Set();

      // Add new alerts
      requests.forEach(req => {
        serverIds.add(req.requestId);
        if (!currentIds.has(req.requestId)) {
          // This is a new request, render it
          renderSosRequest(req);
        }
      });
      
      // Remove old alerts
      currentIds.forEach(id => {
        if (!serverIds.has(id)) {
          // This request is no longer active, close it
          closeSosRequest(id);
        }
      });
      
      // Handle empty state
      if (liveSosList.children.length === 0) {
        liveSosList.innerHTML = '<li class="no-requests">No active SOS requests.</li>';
      } else {
        const placeholder = liveSosList.querySelector('.no-requests');
        if (placeholder) placeholder.remove();
      }

    } catch (e) {
      console.error("Error fetching SOS alerts:", e);
      liveSosList.innerHTML = '<li>Error loading requests.</li>';
    }
  }
  
  /**
   * NEW: Renders a single new SOS card
   * This replaces the logic that was inside your old fetchSosAlerts
   */
  function renderSosRequest(req) {
    // req = { requestId, patientName, bloodType, distance, deadline, patientToken }
    
    const li = document.createElement('li');
    li.className = 'sos-item';
    li.dataset.requestId = req.requestId; // <-- Store request ID
    
    // This is the new HTML structure
    li.innerHTML = `
      <div class="sos-header">
        <span class="blood-needed">Need: ${req.bloodType}</span>
        <span class="patient-distance">~ ${req.distance.toFixed(1)} km away</span>
      </div>
      <div class="sos-details">
        Patient: ${req.patientName} (Token: ${req.patientToken})
      </div>
      <div class="sos-timer-wrap">
        <div class="timer-bar" style="width: 100%;"></div>
        <span class="timer-text">10:00 remaining</span>
      </div>
      <div class="sos-actions">
        <button class="btn-primary accept-btn">Accept</button>
        <button class="btn-danger reject-btn">Reject</button>
      </div>
    `;
    
    liveSosList.prepend(li);
    startCountdown(li, new Date(req.deadline)); // Start its timer
  }
  
  /**
   * NEW: Starts the 10-minute countdown for a card
   */
  function startCountdown(liElement, deadline) {
    const timerBar = liElement.querySelector('.timer-bar');
    const timerText = liElement.querySelector('.timer-text');
    const requestId = liElement.dataset.requestId;
    const totalDuration = 10 * 60 * 1000; // 10 minutes

    const timerInterval = setInterval(() => {
      const now = new Date().getTime();
      const remaining = deadline.getTime() - now;

      if (remaining <= 0) {
        clearInterval(timerInterval);
        liElement.dataset.status = 'closed';
        if(liElement.querySelector('.sos-actions')) liElement.querySelector('.sos-actions').style.display = 'none';
        if(liElement.querySelector('.sos-timer-wrap')) liElement.querySelector('.sos-timer-wrap').style.display = 'none';
        
        const message = document.createElement('div');
        message.className = 'sos-response-message rejected';
        message.textContent = 'TIMED OUT';
        liElement.appendChild(message);
        
        delete sosTimers[requestId];
        return;
      }

      const minutes = Math.floor((remaining / 1000) / 60);
      const seconds = Math.floor((remaining / 1000) % 60);
      timerText.textContent = `${minutes}:${seconds.toString().padStart(2, '0')} remaining`;

      const percentRemaining = (remaining / totalDuration) * 100;
      timerBar.style.width = `${percentRemaining}%`;

      if (percentRemaining < 20) timerBar.className = 'timer-bar critical';
      else if (percentRemaining < 50) timerBar.className = 'timer-bar warning';

    }, 1000);

    sosTimers[requestId] = timerInterval;
  }
  
  /**
   * NEW: Closes a card (e.g., if another hospital accepted)
   */
  function closeSosRequest(requestId) {
    const li = liveSosList.querySelector(`.sos-item[data-request-id="${requestId}"]`);
    if (li && li.dataset.status !== 'closed') {
      li.dataset.status = 'closed';
      if (sosTimers[requestId]) {
        clearInterval(sosTimers[requestId]);
        delete sosTimers[requestId];
      }
      if(li.querySelector('.sos-actions')) li.querySelector('.sos-actions').style.display = 'none';
      if(li.querySelector('.sos-timer-wrap')) li.querySelector('.sos-timer-wrap').style.display = 'none';
      
      const message = document.createElement('div');
      message.className = 'sos-response-message'; // Neutral
      message.textContent = 'Request handled by another hospital.';
      li.appendChild(message);
    }
  }

  // NOTE: Your `window.acceptRequest` function is no longer needed
  // as it's been replaced by `handleHospitalResponse` and event delegation.

  // ===================================================================
  // --- END OF NEW SOS SECTION ---
  // ===================================================================


  // --- Donor Appointment Log (Your existing code) ---
  
  /**
  * Fetches scheduled donor appointments from the server
  */
  async function fetchDonorAppointments() {
    if (!currentHospital) return;
    donorLogList.innerHTML = '';
    donorLogPlaceholder.textContent = 'Loading appointments...';
    donorLogPlaceholder.style.display = 'block';

    try {
      const res = await fetch(`/api/hospital/appointments/${currentHospital.hospital_id}`);
      const appointments = await res.json();

      if (appointments.success && appointments.data.length > 0) {
        donorLogPlaceholder.style.display = 'none';
        appointments.data.forEach(appt => {
          const li = document.createElement('li');
          const apptDate = new Date(appt.appointment_date).toLocaleDateString();
          li.innerHTML = `
            <strong>${appt.full_name} (${appt.blood_type})</strong> - ${apptDate}, ${appt.appointment_time}
            <span>Status: ${appt.status}</span>
          `;
          donorLogList.appendChild(li);
        });
      } else if (appointments.success) {
        donorLogPlaceholder.textContent = 'No appointments found.';
      } else {
        donorLogPlaceholder.textContent = 'Error loading appointments.';
      }
    } catch (err) {
      console.error('Fetch Appointments Error:', err);
      donorLogPlaceholder.textContent = 'Could not connect to server.';
    }
  }

  refreshDonorLogBtn.addEventListener('click', fetchDonorAppointments);


  // --- Utilities (Your existing code) ---
  function displayMessage(el, msg, ok) {
    el.textContent = msg;
    el.style.color = ok ? 'green' : 'red';
    setTimeout(() => { el.textContent = ''; }, 3000);
  }

  logoutBtn.addEventListener('click', () => {
    sessionStorage.removeItem('currentHospital');
    window.location.href = 'hospital-login.html';
  });

  // Start the application
  initializeDashboard();
});