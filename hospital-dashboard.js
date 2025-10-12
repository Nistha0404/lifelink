document.addEventListener('DOMContentLoaded', () => {
    let currentHospital = null;

    // --- Element Selectors ---
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

    // Check-in
    const checkinBtn = document.getElementById('checkin-btn');
    const qrTokenInput = document.getElementById('qr-token-input');
    const checkinMessage = document.getElementById('checkin-message');

    // --- Initialization ---
    function initializeDashboard() {
        const hospitalDataString = sessionStorage.getItem('currentHospital');
        if (!hospitalDataString) {
            window.location.href = 'hospital-login.html';
            return;
        }
        currentHospital = JSON.parse(hospitalDataString);
        welcomeMessage.textContent = `Welcome, ${currentHospital.hospital_name}`;
        renderStockLiteControls();
        startPollingForSOS();
    }

    // --- SOS (Hospital Broadcast) ---
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
            // --- CHANGED THIS LINE ---
            const response = await fetch('/api/server/hospital-sos', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await response.json();
            displayMessage(hospitalSosMessage, result.message, result.success);
        } catch (err) {
            displayMessage(hospitalSosMessage, 'Server connection error.', false);
        }
    });

    // --- Stock Lite ---
    function renderStockLiteControls() {
        inventoryContainer.innerHTML = '';
        const bloodGroups = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
        const currentInventory = currentHospital.blood_inventory || {};

        bloodGroups.forEach(type => {
            const item = currentInventory[type] || { units: 0, confidence: 'Low' };
            const controlHTML = `
                <div class="inventory-item">
                    <label>${type}</label>
                    <input type="number" data-blood-type="${type}" class="stock-units" value="${item.units}" min="0">
                    <select data-blood-type="${type}" class="stock-confidence">
                        <option value="High" ${item.confidence === 'High' ? 'selected' : ''}>High</option>
                        <option value="Medium" ${item.confidence === 'Medium' ? 'selected' : ''}>Medium</option>
                        <option value="Low" ${item.confidence === 'Low' ? 'selected' : ''}>Low</option>
                    </select>
                </div>
            `;
            inventoryContainer.insertAdjacentHTML('beforeend', controlHTML);
        });
    }

    saveInventoryBtn.addEventListener('click', async () => {
        const updatedInventory = {};
        document.querySelectorAll('.inventory-item').forEach(item => {
            const type = item.querySelector('.stock-units').dataset.bloodType;
            const units = parseInt(item.querySelector('.stock-units').value, 10);
            const confidence = item.querySelector('.stock-confidence').value;
            updatedInventory[type] = {
                units,
                confidence,
                timestamp: new Date().toISOString()
            };
        });
        
        try {
            // --- CHANGED THIS LINE ---
            const response = await fetch('/api/server/update-inventory', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ hospitalId: currentHospital.hospital_id, inventory: updatedInventory })
            });
            const result = await response.json();
            if (result.success) {
                currentHospital.blood_inventory = updatedInventory;
                sessionStorage.setItem('currentHospital', JSON.stringify(currentHospital));
            }
            displayMessage(inventoryMessage, result.message, result.success);
        } catch (err) {
            displayMessage(inventoryMessage, 'Server connection error.', false);
        }
    });

    // --- Check-in Scanner ---
    checkinBtn.addEventListener('click', async () => {
        const qrToken = qrTokenInput.value.trim();
        if (!qrToken) {
            displayMessage(checkinMessage, 'Please enter a token.', false);
            return;
        }
        try {
            // --- CHANGED THIS LINE ---
            const response = await fetch('/api/server/donor-checkin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ qrToken })
            });
            const result = await response.json();
            displayMessage(checkinMessage, result.message, result.success);
            if(result.success) qrTokenInput.value = '';
        } catch (err) {
            displayMessage(checkinMessage, 'Server connection error.', false);
        }
    });

    // --- Utility & Other Functions ---
    function displayMessage(element, message, isSuccess) {
        element.textContent = message;
        element.style.color = isSuccess ? 'green' : 'red';
        setTimeout(() => { element.textContent = ''; }, 3000);
    }
    
    // Polling function and logout unchanged
    async function startPollingForSOS() { /* ... unchanged ... */ }
    logoutBtn.addEventListener('click', () => {
        sessionStorage.removeItem('currentHospital');
        window.location.href = 'hospital-login.html';
    });
    
    initializeDashboard();
});