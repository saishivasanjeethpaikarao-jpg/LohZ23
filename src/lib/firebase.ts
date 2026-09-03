import { initializeApp, FirebaseApp } from "firebase/app";
import { getAuth, Auth, GoogleAuthProvider, indexedDBLocalPersistence, setPersistence } from "firebase/auth";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const hasFirebaseConfig = Boolean(firebaseConfig.apiKey);

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
const googleProvider = new GoogleAuthProvider();
googleProvider.addScope("profile");
googleProvider.addScope("email");

if (hasFirebaseConfig) {
  try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    // Use IndexedDB persistence so auth state survives Electron renderer
    // restarts and tab refreshes. This is safe in both browser and Electron.
    setPersistence(auth, indexedDBLocalPersistence).catch((err) => {
      console.warn("[Firebase] Could not set IndexedDB persistence (falling back to in-memory):", err);
    });
  } catch (err) {
    console.warn("[Firebase] Failed to initialize:", err);
  }
}

export { app, auth, googleProvider };
export const isFirebaseEnabled = hasFirebaseConfig && auth !== null;
