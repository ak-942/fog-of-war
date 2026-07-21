import { registerPlugin } from '@capacitor/core';
const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');

async function startGPS() {
  try {
    // Request background location tracking watcher
    await BackgroundGeolocation.addWatcher(
      {
        backgroundMessage: "Tracking your explored areas in background...",
        backgroundTitle: "Fog of War Active",
        requestPermissions: true,
        stale: false,
        distanceFilter: 5 // Only trigger updates every 5 meters moved
      },
      (location, error) => {
        if (error) {
          if (error.code === "NOT_AUTHORIZED") {
            alert("Please set Location permission to 'Allow All The Time' in Android Settings.");
          }
          return;
        }

        if (location) {
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
    console.warn("Background GPS Fallback to Browser GPS:", err);
    // Standard web geolocation fallback
    navigator.geolocation.watchPosition(
      (pos) => onLocationUpdate(pos, false),
      (err) => console.warn('Watch GPS Error:', err),
      { enableHighAccuracy: true }
    );
  }
}