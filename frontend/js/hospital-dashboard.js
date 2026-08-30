document.addEventListener("DOMContentLoaded", () => {
  const hospitalId = localStorage.getItem("hospitalId") || "HOSP001";
  const liveSOSList = document.getElementById("live-sos-list");
  const hospitalSOSForm = document.getElementById("hospital-sos-form");
  const messageArea = document.getElementById("hospital-sos-message");

  // ========== SOS Broadcast ==========
  hospitalSOSForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = {
      hospitalId,
      component: document.getElementById("sos-component").value,
      bloodType: document.getElementById("sos-blood-type").value,
      units: parseInt(document.getElementById("sos-units").value),
      urgency: document.getElementById("sos-urgency").value,
    };
    try {
      const res = await fetch("/api/server/hospital-sos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const result = await res.json();
      messageArea.textContent = result.message || "SOS broadcasted successfully.";
      messageArea.style.color = "green";
    } catch {
      messageArea.textContent = "Error broadcasting SOS.";
      messageArea.style.color = "red";
    }
  });

  // ========== Live SOS Monitor ==========
  async function fetchSOS() {
    try {
      const res = await fetch(`/api/server/sos-alerts/${hospitalId}`);
      const sosData = await res.json();
      renderSOSList(sosData);
    } catch (err) {
      console.error("Failed to fetch SOS alerts:", err);
    }
  }

  function renderSOSList(sosList) {
    liveSOSList.innerHTML = "";
    if (!sosList || sosList.length === 0) {
      liveSOSList.innerHTML = '<li class="no-requests">No active SOS requests.</li>';
      return;
    }

    sosList.forEach((sos) => {
      const li = document.createElement("li");
      li.classList.add("sos-item");
      li.dataset.sosId = sos.id;
      li.dataset.status = sos.status || "active";

      li.innerHTML = `
        <div class="sos-header">
          <span class="blood-needed">${sos.blood_type} Required</span>
          <span class="patient-distance">${sos.distance || 0} km away</span>
        </div>
        <div class="sos-details">
          <div>Patient: ${sos.patient_name || "Anonymous"}</div>
          <div>Urgency: ${sos.urgency}</div>
        </div>
        <div class="sos-timer-wrap">
          <div class="timer-bar" id="bar-${sos.id}" style="width:100%"></div>
          <span class="timer-text" id="timer-${sos.id}">10:00</span>
        </div>
        <div class="sos-actions">
          <button class="btn-primary accept-btn" data-id="${sos.id}">Accept</button>
          <button class="btn-danger reject-btn" data-id="${sos.id}">Reject</button>
        </div>
        <div class="sos-response-message" id="response-${sos.id}"></div>
      `;
      liveSOSList.appendChild(li);
      startTimer(sos.id, 600);
    });
  }

  function startTimer(id, duration) {
    let timeLeft = duration;
    const bar = document.getElementById(`bar-${id}`);
    const text = document.getElementById(`timer-${id}`);
    const interval = setInterval(() => {
      timeLeft--;
      const percent = (timeLeft / duration) * 100;
      bar.style.width = percent + "%";
      if (timeLeft < 300) bar.classList.add("warning");
      if (timeLeft < 120) bar.classList.add("critical");
      text.textContent = `${Math.floor(timeLeft / 60)}:${String(timeLeft % 60).padStart(2, "0")}`;
      if (timeLeft <= 0) {
        clearInterval(interval);
        autoRejectSOS(id);
      }
    }, 1000);
  }

  async function autoRejectSOS(id) {
    await respondToSOS(id, "Rejected", true);
  }

  liveSOSList.addEventListener("click", async (e) => {
    if (e.target.classList.contains("accept-btn")) {
      await respondToSOS(e.target.dataset.id, "Accepted");
    }
    if (e.target.classList.contains("reject-btn")) {
      await respondToSOS(e.target.dataset.id, "Rejected");
    }
  });

  async function respondToSOS(id, status, isAuto = false) {
    try {
      const res = await fetch("/api/server/hospital-response", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sosId: id, hospitalId, status }),
      });
      const result = await res.json();
      const msgEl = document.getElementById(`response-${id}`);
      msgEl.textContent = isAuto ? "Auto rejected after 10 mins." : result.message;
      msgEl.classList.add(status === "Accepted" ? "accepted" : "rejected");
      document.querySelector(`.sos-item[data-sos-id="${id}"]`).dataset.status = "closed";
    } catch (err) {
      console.error("SOS response failed:", err);
    }
  }

  // ========== Inventory Management ==========
  document.getElementById("save-inventory-btn").addEventListener("click", async () => {
    const payload = { hospitalId, stock: { "A+": 10, "O+": 8 } }; // example stock
    const res = await fetch("/api/server/update-inventory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await res.json();
    document.getElementById("inventory-message").textContent = result.message;
  });

  // ========== Token Verification ==========
  document.getElementById("verify-btn").addEventListener("click", async () => {
    const token = document.getElementById("verify-token-input").value.trim();
    const res = await fetch("/api/server/verify-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const result = await res.json();
    document.getElementById("verify-results").textContent =
      result.valid ? `Valid Token: ${result.name}` : "Invalid token";
  });

  // ========== Donor Appointment Log ==========
  document.getElementById("refresh-donor-log-btn").addEventListener("click", async () => {
    const res = await fetch(`/api/hospital/appointments/${hospitalId}`);
    const data = await res.json();
    const list = document.getElementById("donor-log-list");
    list.innerHTML = "";
    if (!data || data.length === 0) {
      list.innerHTML = '<li id="donor-log-placeholder">No appointments found.</li>';
      return;
    }
    data.forEach((a) => {
      const li = document.createElement("li");
      li.textContent = `${a.donor_name} - ${a.date} (${a.status})`;
      list.appendChild(li);
    });
  });

  // Poll SOS every 10s
  fetchSOS();
  setInterval(fetchSOS, 10000);
});