import { useState, useCallback, useMemo } from "react";
import { GoogleMap, useJsApiLoader, MarkerF, InfoWindowF } from "@react-google-maps/api";

// ── Real Google Maps integration — used only in the deployed (Vercel) build ──
// Falls back to the SVG IndiaMap automatically if VITE_GOOGLE_MAPS_API_KEY
// isn't set (see App.jsx — MapView wrapper decides which to render).

const INDIA_CENTER = { lat: 22.5, lng: 79.0 };
const DEFAULT_ZOOM = 5;

const C = {
  navy: "#0F1B2D", bg: "#F8FAFB", green: "#1E6B4A", red: "#C84B31",
  blue: "#2563EB", amber: "#F59E0B", lightBlue: "#EFF6FF",
  border: "#E2E8F0", muted: "#64748B", dark: "#1E293B",
};

function scoreColor(s) {
  return s >= 80 ? C.green : s >= 65 ? C.blue : s >= 50 ? C.amber : C.red;
}

// Map styling to match the app's clean, muted aesthetic instead of default Google colors
const MAP_STYLES = [
  { featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] },
  { featureType: "transit", elementType: "labels", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#E8EEF5" }] },
  { featureType: "landscape", elementType: "geometry", stylers: [{ color: "#F8FAFB" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#FFFFFF" }] },
  { featureType: "administrative", elementType: "labels.text.fill", stylers: [{ color: "#64748B" }] },
];

const mapContainerStyle = { width: "100%", height: "100%" };

export default function GoogleMapView({ pins = [], onStateClick, focusLat, focusLng, focusZoom = 11, height = 400 }) {
  const { isLoaded } = useJsApiLoader({
    id: "google-map-script",
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY,
  });

  const [map, setMap] = useState(null);
  const [activePin, setActivePin] = useState(null);

  const onLoad = useCallback((m) => setMap(m), []);
  const onUnmount = useCallback(() => setMap(null), []);

  // Pan/zoom to a focused location when Analyze/Screener supply lat/lng
  const center = useMemo(() => {
    if (focusLat && focusLng) return { lat: focusLat, lng: focusLng };
    return INDIA_CENTER;
  }, [focusLat, focusLng]);

  const zoomLevel = focusLat && focusLng ? focusZoom : DEFAULT_ZOOM;

  if (!import.meta.env.VITE_GOOGLE_MAPS_API_KEY) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center",
        background: "#FFFBEB", borderRadius: 12, border: "1px solid #FDE68A",
        flexDirection: "column", gap: 8, fontFamily: "Inter,sans-serif", fontSize: 13, color: "#92400E", padding: 20, textAlign: "center" }}>
        <div style={{ fontSize: 24 }}>🗺️</div>
        <div>Google Maps API key not configured.</div>
        <div style={{ fontSize: 11, opacity: 0.8 }}>Add VITE_GOOGLE_MAPS_API_KEY to use the live map. Falling back to built-in map.</div>
      </div>
    );
  }

  if (!isLoaded) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center",
        background: "#F1F5F9", borderRadius: 12, border: "1px solid " + C.border,
        flexDirection: "column", gap: 8, fontFamily: "Inter,sans-serif", fontSize: 13, color: C.muted }}>
        <div style={{ fontSize: 24 }}>🗺️</div>
        <div>Loading Google Maps…</div>
      </div>
    );
  }

  return (
    <div style={{ position: "relative", borderRadius: 12, overflow: "hidden", border: "1px solid " + C.border, height }}>
      <GoogleMap
        mapContainerStyle={mapContainerStyle}
        center={center}
        zoom={zoomLevel}
        onLoad={onLoad}
        onUnmount={onUnmount}
        options={{
          styles: MAP_STYLES,
          disableDefaultUI: false,
          zoomControl: true,
          streetViewControl: true,
          mapTypeControl: true,
          fullscreenControl: false,
        }}
      >
        {pins.map((p, i) => {
          if (!p.lat || !p.lng) return null;
          return (
            <MarkerF
              key={i}
              position={{ lat: p.lat, lng: p.lng }}
              onClick={() => setActivePin(p)}
              label={{
                text: String(p.growth_score || "?"),
                color: "#fff",
                fontSize: "11px",
                fontWeight: "700",
              }}
              icon={{
                path: window.google?.maps?.SymbolPath?.CIRCLE,
                fillColor: scoreColor(p.growth_score || 60),
                fillOpacity: 1,
                strokeColor: "#fff",
                strokeWeight: 2,
                scale: 14,
              }}
            />
          );
        })}

        {activePin && (
          <InfoWindowF
            position={{ lat: activePin.lat, lng: activePin.lng }}
            onCloseClick={() => setActivePin(null)}
          >
            <div style={{ fontFamily: "Inter,sans-serif", minWidth: 160 }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: C.dark, marginBottom: 4 }}>
                {activePin.location || activePin.location_name}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
                {activePin.growth_score != null && (
                  <span style={{ background: scoreColor(activePin.growth_score), color: "#fff",
                    borderRadius: 4, padding: "2px 7px", fontSize: 11, fontWeight: 700 }}>
                    Score {activePin.growth_score}
                  </span>
                )}
                {activePin.expected_cagr && (
                  <span style={{ background: C.lightBlue, color: C.blue, borderRadius: 4,
                    padding: "2px 7px", fontSize: 11, fontWeight: 600 }}>
                    {activePin.expected_cagr}
                  </span>
                )}
              </div>
              {activePin.current_price_sqft && (
                <div style={{ fontSize: 11, color: C.muted }}>{activePin.current_price_sqft}</div>
              )}
              {activePin.one_line_thesis && (
                <div style={{ fontSize: 10, color: C.muted, fontStyle: "italic", marginTop: 4, lineHeight: 1.4 }}>
                  {activePin.one_line_thesis}
                </div>
              )}
            </div>
          </InfoWindowF>
        )}
      </GoogleMap>
    </div>
  );
}
