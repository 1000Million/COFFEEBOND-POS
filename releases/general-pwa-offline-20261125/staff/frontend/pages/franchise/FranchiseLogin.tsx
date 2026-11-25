import { useState } from 'react';
import { Link } from 'react-router-dom';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { AlertCircle, BarChart3, Loader2, LockKeyhole } from 'lucide-react';
import { auth } from '../../lib/firebase';

const FRANCHISE_AUTH_DOMAIN = 'franchise.pos.coffeebond.in';
const USERNAME_PATTERN = /^[a-z0-9._-]{4,40}$/;

export default function FranchiseLogin() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const normalizedUsername = username.trim().toLowerCase();
    if (!USERNAME_PATTERN.test(normalizedUsername)) {
      setError('Enter your assigned franchise username.');
      return;
    }

    setSubmitting(true);
    try {
      await signInWithEmailAndPassword(
        auth,
        `${normalizedUsername}@${FRANCHISE_AUTH_DOMAIN}`,
        password,
      );
    } catch {
      setError('The username or password is incorrect, or this access has been revoked.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-[100dvh] bg-[#f7f1ea] px-4 py-8 text-neutral-900 flex items-center justify-center">
      <section className="w-full max-w-md overflow-hidden rounded-2xl border border-[#e5d9cc] bg-white shadow-[0_18px_50px_rgba(70,43,31,0.10)]">
        <div className="bg-[#3e2723] px-6 py-7 text-white">
          <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl bg-white/10">
            <BarChart3 size={23} />
          </div>
          <h1 className="text-2xl font-black">Franchise Sales</h1>
          <p className="mt-1 text-sm text-white/70">Coffee Bond read-only reporting</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5 p-6">
          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">
              <AlertCircle size={18} className="mt-0.5 shrink-0" />
              {error}
            </div>
          )}

          <label className="block">
            <span className="text-xs font-black uppercase tracking-wider text-neutral-500">Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              className="mt-2 h-12 w-full rounded-xl border border-neutral-200 px-4 text-base outline-none transition focus:border-[#5c4033] focus:ring-4 focus:ring-[#5c4033]/10"
              placeholder="goldeni.owner"
              required
            />
          </label>

          <label className="block">
            <span className="text-xs font-black uppercase tracking-wider text-neutral-500">Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              className="mt-2 h-12 w-full rounded-xl border border-neutral-200 px-4 text-base outline-none transition focus:border-[#5c4033] focus:ring-4 focus:ring-[#5c4033]/10"
              required
            />
          </label>

          <button
            type="submit"
            disabled={submitting}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#3e2723] font-black text-white transition hover:bg-[#2d1c19] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? <Loader2 className="animate-spin" size={19} /> : <LockKeyhole size={18} />}
            {submitting ? 'Signing in...' : 'Open daily sales'}
          </button>

          <Link to="/login" className="block text-center text-sm font-bold text-[#5c4033] hover:underline">
            Staff sign in
          </Link>
        </form>
      </section>
    </main>
  );
}
