import { registerPlugin } from '@capacitor/core';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { latLngToCell } from 'h3-js';
import { FogEngine } from './fogEngine.js'; 

const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');

// --- 1. Map & Fog Engine Setup ---
// Initialize map (starts centered at a default location)
const map = L.map('map').setView([22.7196, 75.8577], 15);

// Add OpenStreetMap tile layer
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap'
}).addTo(map);

// Canvas overlay initialization
const canvas = document.getElementById('fog-canvas');
const fogEngine = new FogEngine(canvas, map);

// App State
let unlockedCells = new Set(); // Using a Set to avoid duplicate hexes
let userMarker = null;
let initialCenterDone = false;
let isTrackingActive = true;

// Initial fog render (covers entire map)
fogEngine.render(Array.from(unlockedCells));

// Re-render fog smoothly on pan/zoom
map.on('move', () => {
  fogEngine.render(Array.from(unlockedCells));
});

// --- 2. Location Update Handler ---
function onLocationUpdate(position) {
  const { latitude, longitude, speed } = position.coords;

  // A. Center map on user for the first fix
  if (!initialCenterDone) {
    map.setView([latitude, longitude], 16);
    initialCenterDone = true;
  }

  // B. Update or create user location marker
  if (!userMarker) {
    userMarker = L.circleMarker([latitude, longitude], {
      radius: 8,
      fillColor: '#3b82f6',
      color: '#ffffff',
      weight: 3,
      opacity: 1,
      fillOpacity: 1
    }).addTo(map);
  } else {
    userMarker.setLatLng([latitude, longitude]);
  }

  // C. Unlock H3 Cell at current GPS location (Resolution 9 = ~100m hex)
  const currentCell = latLngToCell(latitude, longitude, 9);
  if (!unlockedCells.has(currentCell)) {
    unlockedCells.add(currentCell);
    updateUIStats(speed);
  }

  // D. Redraw Fog Overlay
  fogEngine.render(Array.from(unlockedCells));
}

// Update DOM elements from index.html
function updateUIStats(speedMetersPerSec) {
  const countDisplay = document.getElementById('unlockedCount');
  const speedDisplay = document.getElementById('speedDisplay');

  if (countDisplay) {
    countDisplay.textContent = unlockedCells.size;
  }

  if (speedDisplay) {
    // Convert m/s to km/h
    const kmh = speedMetersPerSec ? Math.round(speedMetersPerSec * 3.6) : 0;
    speedDisplay.textContent = `${kmh} km/h`;
  }
}

// --- 3. Request Location & Start Tracking ---
async function startGPS() {
  // Web Browser Geolocation Standard Prompt
  if ('geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition(
      (pos) => onLocationUpdate(pos),
      (err) => {
        console.warn('Initial web location prompt denied or failed:', err);
        alert('Please allow location access in your browser settings to reveal the map fog!');
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  // Mobile App Native Background Tracker
  try {
    await BackgroundGeolocation.addWatcher(
      {
        backgroundMessage: "Tracking your explored areas in background...",
        backgroundTitle: "Fog of War Active",
        requestPermissions: true,
        stale: false,
        distanceFilter: 5 // Trigger updates every 5 meters moved
      },
      (location, error) => {
        if (error) {
          if (error.code === "NOT_AUTHORIZED") {
            alert("Please set Location permission to 'Allow All The Time' in settings.");
          }
          return;
        }

        if (location && isTrackingActive) {
          onLocationUpdate({
            coords: {
              latitude: location.latitude,
              longitude: location.longitude,
              speed: location.speed
            }
          });
        }
      }
    );
  } catch (err) {
    console.warn("Native Background Plugin not available, using web fallback:", err);
    // Web Watcher Fallback
    navigator.geolocation.watchPosition(
      (pos) => {
        if (isTrackingActive) onLocationUpdate(pos);
      },
      (err) => console.warn('Watch GPS Error:', err),
      { enableHighAccuracy: true }
    );
  }
}

// --- 4. Button Controls Setup ---
document.getElementById('btnCenter')?.addEventListener('click', () => {
  if (userMarker) {
    map.setView(userMarker.getLatLng(), 16);
  }
});

document.getElementById('btnToggleTracking')?.addEventListener('click', (e) => {
  isTrackingActive = !isTrackingActive;
  e.currentTarget.classList.toggle('btn-active', isTrackingActive);
});

document.getElementById('btnClear')?.addEventListener('click', () => {
  if (confirm('Are you sure you want to clear your unlocked fog progress?')) {
    unlockedCells.clear();
    updateUIStats(0);
    fogEngine.render([]);
  }
});

// Immediately initiate location request on app launch
startGPS();