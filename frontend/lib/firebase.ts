/// <reference types="vite/client" />
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getFunctions } from "firebase/functions";
import { getStorage } from "firebase/storage";

const requiredFirebaseEnv = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
] as const;

const firebaseEnv = import.meta.env;
const FIREBASE_STORAGE_BUCKET = "coffee-bond-pos.firebasestorage.app";

const missingFirebaseEnv = requiredFirebaseEnv.filter((key) => {
  const value = firebaseEnv[key];
  return !value || value.startsWith("your_") || value.includes("your_project_id");
});

if (missingFirebaseEnv.length > 0) {
  const message = `Coffee Bond POS Firebase configuration is incomplete. Missing or placeholder values: ${missingFirebaseEnv.join(", ")}. Create a local .env from .env.example and add your Firebase web app config.`;

  if (typeof document !== "undefined") {
    document.body.innerHTML = `
      <main style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f9f5f0;font-family:Inter,system-ui,sans-serif;padding:24px;color:#3e2723;">
        <section style="max-width:680px;background:white;border:1px solid #e7ddd5;border-radius:16px;padding:28px;box-shadow:0 8px 30px rgba(0,0,0,0.05);">
          <h1 style="margin:0 0 12px;font-size:24px;">Firebase configuration missing</h1>
          <p style="margin:0 0 16px;line-height:1.5;color:#5f504a;">${message}</p>
          <code style="display:block;background:#f4eee9;padding:12px;border-radius:10px;white-space:pre-wrap;color:#5c4033;">${missingFirebaseEnv.join("\n")}</code>
        </section>
      </main>
    `;
  }

  throw new Error(message);
}

export const firebaseConfig = {
  apiKey: firebaseEnv.VITE_FIREBASE_API_KEY,
  authDomain: firebaseEnv.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: firebaseEnv.VITE_FIREBASE_PROJECT_ID,
  storageBucket: FIREBASE_STORAGE_BUCKET,
  messagingSenderId: firebaseEnv.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: firebaseEnv.VITE_FIREBASE_APP_ID,
  measurementId: firebaseEnv.VITE_FIREBASE_MEASUREMENT_ID,
};

export const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, firebaseEnv.VITE_FIREBASE_FUNCTIONS_REGION || "us-central1");
export const storage = getStorage(app);
