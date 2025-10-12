// This module exports a function to get the user's geolocation.
// It returns a Promise that resolves with the position or rejects with an error.

export function getGeolocation() {
    return new Promise((resolve, reject) => {
        // First, check if the browser supports the Geolocation API
        if (!navigator.geolocation) {
            return reject({ code: -1, message: "Geolocation is not supported by this browser." });
        }

        // Options for the location request
        const options = {
            enableHighAccuracy: true, // Request a more precise location if available
            timeout: 15000,           // Set a 15-second timeout to avoid long waits
            maximumAge: 0             // Do not use a cached position
        };

        // Request the current position
        navigator.geolocation.getCurrentPosition(resolve, reject, options);
    });
}
