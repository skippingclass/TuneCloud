import { useState } from 'react';
import { Radio, Lock, User, ArrowRight } from 'lucide-react';
import { api, setAuthToken } from '../api.js';

export function LoginView({ onLogin, notice }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErr('');
    setLoading(true);
    try {
      const data = await api.login(username, password);
      setAuthToken(data.token);
      onLogin(data.user);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-surface-950 relative overflow-hidden select-none">
      {/* Background ambient glowing orbs */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-accent/15 rounded-full filter blur-[120px] pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-accent-hover/10 rounded-full filter blur-[140px] pointer-events-none" />

      <div className="w-full max-w-sm relative z-10 space-y-6 animate-slide-up">
        {/* Brand header */}
        <div className="text-center space-y-2">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-accent to-accent-hover flex items-center justify-center mx-auto shadow-glow">
            <Radio className="w-8 h-8 text-surface-950 stroke-[2.5]" />
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-white">
            TuneCloud
          </h1>
          <p className="text-xs text-surface-400">
            Sign in to stream your personal collection
          </p>
        </div>

        {/* Glass form card */}
        <div className="glass-panel p-6 sm:p-7 rounded-3xl border border-white/[0.08] shadow-glass-lg space-y-5">
          {notice && <p role="status" className="text-xs text-surface-300 mb-4">{notice}</p>}
        <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-surface-400 mb-1.5">
                Username
              </label>
              <div className="relative">
                <User className="w-4 h-4 text-surface-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Enter your username"
                  className="glass-input w-full pl-10 pr-3.5 py-2.5"
                  autoFocus
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-surface-400 mb-1.5">
                Password
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-surface-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  className="glass-input w-full pl-10 pr-3.5 py-2.5"
                  required
                />
              </div>
            </div>

            {err && (
              <p className="text-xs text-rose-400 bg-rose-500/10 p-2.5 rounded-xl border border-rose-500/20">
                {err}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="btn-primary w-full py-2.5 shadow-glow"
            >
              <span>{loading ? 'Authenticating...' : 'Sign In'}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
