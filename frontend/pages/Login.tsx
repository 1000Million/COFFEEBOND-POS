import React, { useState } from "react";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "../lib/firebase";
import { useNavigate } from "react-router-dom";
import { Coffee, Loader2, AlertCircle, Copy } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { motion } from "motion/react";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const navigate = useNavigate();
  const { staffProfile } = useAuth();

  // If already logged in, they shouldn't see log in page
  // We'll handle exact redirect logic in a ProtectedRoute or inside App.tsx,
  // but a simple redirect here is also good.

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg("");
    setErrorCode("");
    setIsSubmitting(true);

    try {
      await signInWithEmailAndPassword(auth, email, password);
      // Navigation is handled by the Auth state observer in a routing wrapper
    } catch (err: any) {
      console.error(err);
      setErrorMsg(
        err.message || "Failed to sign in. Please check your credentials.",
      );
      setErrorCode(err.code || "");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f9f5f0] flex flex-col items-center justify-center p-4 font-sans text-neutral-800">
      <div className="w-full max-w-sm">
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
          className="flex flex-col items-center mb-8"
        >
          <motion.div
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="w-16 h-16 bg-[#5c4033] rounded-2xl flex items-center justify-center text-[#f9f5f0] mb-4 shadow-sm cursor-pointer"
          >
            <Coffee size={32} />
          </motion.div>
          <h1 className="text-3xl font-black tracking-tight text-[#3e2723]">
            Coffee Bond
          </h1>
          <p className="text-sm font-medium text-neutral-500 uppercase tracking-widest mt-1">
            Point of Sale
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, scale: 0.98, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1, ease: "easeOut" }}
          className="bg-white rounded-3xl p-8 shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-neutral-100"
        >
          <h2 className="text-xl font-bold mb-6 text-center text-neutral-800">
            Staff Login
          </h2>

          {errorMsg && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              className="bg-red-50 text-red-700 text-sm p-4 rounded-xl mb-6 flex flex-col gap-3 border border-red-100 overflow-hidden"
            >
              <div className="flex items-start gap-3">
                <AlertCircle size={18} className="shrink-0 mt-0.5" />
                <span className="font-medium">
                  {errorCode === "auth/network-request-failed"
                    ? "Firebase Authentication is blocking this preview domain."
                    : errorMsg}
                </span>
              </div>

              {errorCode === "auth/network-request-failed" ? (
                <div className="mt-2 text-xs bg-white p-4 rounded-lg border border-red-200 space-y-3 shadow-sm">
                  <div className="flex flex-col gap-1">
                    <span className="text-neutral-500 font-bold uppercase tracking-widest text-[10px]">
                      Current Hostname
                    </span>
                    <div className="bg-neutral-50 border border-neutral-200 px-3 py-2 flex items-center justify-between rounded-md">
                      <span className="font-mono text-neutral-800 font-semibold select-all truncate">
                        {window.location.hostname}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          navigator.clipboard.writeText(
                            window.location.hostname,
                          )
                        }
                        className="text-[#5c4033] font-bold text-xs hover:underline flex items-center gap-1.5 shrink-0 ml-3"
                      >
                        <Copy size={14} /> Copy hostname
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-neutral-500 font-bold uppercase tracking-widest text-[10px]">
                      Firebase Project ID
                    </span>
                    <span className="font-mono text-neutral-800">
                      {import.meta.env.VITE_FIREBASE_PROJECT_ID || "undefined"}
                    </span>
                  </div>

                  <div className="bg-red-50 p-3 rounded-md border border-red-100 text-red-800 mt-2">
                    <p className="font-bold mb-2 uppercase tracking-wide text-[11px]">
                      Instructions
                    </p>
                    <p className="mb-2">
                      Go to{" "}
                      <b>
                        Firebase Console → Authentication → Settings →
                        Authorized domains → Add domain
                      </b>
                    </p>
                    <p className="text-red-600 font-medium italic">
                      Do not include https:// or any path.
                    </p>
                  </div>
                </div>
              ) : (
                errorCode &&
                import.meta.env.DEV && (
                  <div className="mt-2 text-xs bg-white p-3 rounded-lg border border-red-200 font-mono space-y-1.5 overflow-x-auto shadow-sm">
                    <p className="font-semibold text-red-800 mb-2 uppercase tracking-widest text-[10px]">
                      Dev Diagnostics
                    </p>
                    <p>
                      <span className="text-neutral-500">Code:</span>{" "}
                      {errorCode}
                    </p>
                    <p>
                      <span className="text-neutral-500">Project ID:</span>{" "}
                      {import.meta.env.VITE_FIREBASE_PROJECT_ID || "undefined"}
                    </p>
                    <p>
                      <span className="text-neutral-500">Auth Domain:</span>{" "}
                      {import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "undefined"}
                    </p>
                    <p>
                      <span className="text-neutral-500">
                        Current Hostname:
                      </span>{" "}
                      {window.location.hostname}
                    </p>
                  </div>
                )
              )}
            </motion.div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                className="block text-xs font-bold text-neutral-500 uppercase tracking-widest mb-2"
                htmlFor="email"
              >
                Email Address
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033] transition-colors"
                placeholder="staff@coffeebond.com"
                required
              />
            </div>

            <div>
              <label
                className="block text-xs font-bold text-neutral-500 uppercase tracking-widest mb-2"
                htmlFor="password"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 bg-neutral-50 border border-neutral-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#5c4033]/20 focus:border-[#5c4033] transition-colors"
                placeholder="••••••••"
                required
              />
            </div>

            <motion.button
              type="submit"
              disabled={isSubmitting}
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.99 }}
              className="w-full py-3.5 px-4 bg-[#3e2723] hover:bg-[#2d1c19] focus:ring-4 focus:ring-[#3e2723]/20 text-[#f9f5f0] font-semibold rounded-xl transition-all flex items-center justify-center mt-6 disabled:opacity-70 disabled:cursor-not-allowed cursor-pointer"
            >
              {isSubmitting ? (
                <Loader2 size={20} className="animate-spin" />
              ) : (
                "Sign In to POS"
              )}
            </motion.button>
          </form>
        </motion.div>
      </div>
    </div>
  );
}
