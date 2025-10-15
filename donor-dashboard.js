import { getGeolocation } from './geolocation.js';

async function fetchNearbyCamps() {
  const msg = document.getElementById('camp-message');
  msg.textContent = 'Fetching your location...';
  try {
    const { position } = await getGeolocation();
    const lat = position.coords.latitude;
    const lon = position.coords.longitude;
    const res = await fetch(`/api/server/camps/nearby?lat=${lat}&lon=${lon}`);
    const camps = await res.json();
    renderCamps(camps);
    msg.textContent = '';
  } catch (err) {
    msg.textContent = err.message || 'Unable to get location for camp search.';
    msg.style.color = 'red';
  }
}
