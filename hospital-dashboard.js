const baseURL = "[https://your-vercel-api-url.vercel.app](https://your-vercel-api-url.vercel.app)"; // replace with your actual deployed backend URL

document.getElementById("loadAlertsBtn").addEventListener("click", loadAlerts);
document.getElementById("verifyTokenBtn").addEventListener("click", verifyToken);
document.getElementById("updateInventoryBtn").addEventListener("click", updateInventory);

async function loadAlerts() {
const hospitalId = document.getElementById("hospitalId").value.trim();
if (!hospitalId) return alert("Enter Hospital ID first!");

const res = await fetch(`${baseURL}/api/server/sos-alerts/${hospitalId}`);
const alerts = await res.json();
const list = document.getElementById("alertsList");
list.innerHTML = "";

if (!alerts.length) {
list.innerHTML = "<p class='text-muted'>No active SOS alerts.</p>";
return;
}

alerts.forEach(a => {
const div = document.createElement("div");
div.className = "sos-alert";
div.innerHTML = `       <strong>Patient:</strong> ${a.patientName}<br/>       <strong>Blood Type:</strong> ${a.bloodType}<br/>       <strong>Distance:</strong> ${a.distance.toFixed(2)} km<br/>       <strong>Deadline:</strong> ${new Date(a.deadline).toLocaleTimeString()}<br/>       <div class="mt-2">         <button class="btn btn-success btn-response" onclick="respondSOS('${a.requestId}','${hospitalId}','accept')">Accept</button>         <button class="btn btn-danger" onclick="respondSOS('${a.requestId}','${hospitalId}','reject')">Reject</button>       </div>`;
list.appendChild(div);
});
}

async function respondSOS(requestId, hospitalId, response) {
try {
const res = await fetch(`${baseURL}/api/server/hospital-response`, {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({ requestId, hospitalId, response }),
});
const data = await res.json();
if (data.success) {
alert(response === "accept" ? "You accepted the SOS request!" : "You rejected the SOS request.");
loadAlerts();
} else {
alert(data.message || "Error processing response.");
}
} catch (e) {
console.error(e);
alert("Network or server error.");
}
}

async function verifyToken() {
const token = document.getElementById("tokenInput").value.trim();
if (!token) return alert("Enter a 4-digit token!");
const res = await fetch(`${baseURL}/api/hospital/verify-token`, {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({ token }),
});
const data = await res.json();
document.getElementById("tokenResult").textContent = JSON.stringify(data, null, 2);
}

async function updateInventory() {
const hospitalId = document.getElementById("hospitalId").value.trim();
if (!hospitalId) return alert("Enter Hospital ID first!");

let inventory;
try {
inventory = JSON.parse(document.getElementById("inventoryData").value);
} catch {
return alert("Enter valid JSON data for inventory.");
}

const res = await fetch(`${baseURL}/api/server/update-inventory`, {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({ hospitalId, inventory }),
});

const data = await res.json();
document.getElementById("updateResult").textContent = JSON.stringify(data, null, 2);
}
