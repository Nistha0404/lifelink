import { getGeolocation } from './geolocation.js';

document.addEventListener('DOMContentLoaded', () => {
  const sosBtn = document.getElementById('send-sos-btn');
  const sosMessage = document.getElementById('sos-message');

  sosBtn.addEventListener('click', async () => {
    sosBtn.disabled = true;
    sosMessage.textContent = 'Getting location...';

    try {
      const { position } = await getGeolocation();
      const lat = position.coords.latitude;
      const lon = position.coords.longitude;

      const patient = JSON.parse(sessionStorage.getItem('currentPatient'));
      if (!patient) throw new Error('Patient session not found.');

      const payload = {
        patientId: patient.user_id,
        bloodType: patient.blood_type,
        pincode: patient.pincode,
        latitude: lat,
        longitude: lon,
      };

      const res = await fetch('/api/server/request-blood', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      sosMessage.textContent = data.message || 'SOS request sent!';
      sosMessage.style.color = data.success ? 'green' : 'red';
    } catch (err) {
      sosMessage.textContent =
        err.message ||
        (err.code === 'denied'
          ? 'Location permission denied. Please enable it in settings.'
          : 'Could not get location.');
      sosMessage.style.color = 'red';
    } finally {
      sosBtn.disabled = false;
    }
  });
});
