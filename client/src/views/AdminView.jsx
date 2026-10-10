import { useState, useEffect } from 'react';
import { Shield, UserPlus, Users, Loader2 } from 'lucide-react';
import { api } from '../api.js';

export function AdminView() {
  const [users, setUsers] = useState([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [loading, setLoading] = useState(false);

  const load = () => api.adminUsers().then(setUsers).catch(console.error);
  useEffect(() => {
    load();
  }, []);

  const create = async (e) => {
    e.preventDefault();
    setErr('');
    setOk('');
    setLoading(true);
    try {
      await api.register(username, password);
      setOk(`User "${username}" created successfully`);
      setUsername('');
      setPassword('');
      load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-xl space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2.5">
          <Shield className="w-6 h-6 text-accent" />
          <span>Admin — User Management</span>
        </h1>
        <p className="text-xs text-surface-400 mt-1">
          Create and manage system user accounts.
        </p>
      </div>

      <div className="glass-panel p-6 rounded-3xl border border-white/[0.08] space-y-4">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <UserPlus className="w-4 h-4 text-accent" />
          <span>Create New User</span>
        </h3>
        <form onSubmit={create} className="space-y-3.5">
          <div>
            <label className="block text-xs font-semibold text-surface-400 mb-1">
              Username
            </label>
            <input
              className="glass-input w-full"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-surface-400 mb-1">
              Password
            </label>
            <input
              className="glass-input w-full"
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {err && <p className="text-xs text-rose-400">{err}</p>}
          {ok && <p className="text-xs text-emerald-400">{ok}</p>}

          <button
            type="submit"
            disabled={loading}
            className="btn-primary w-full py-2.5"
          >
            {loading ? 'Creating...' : 'Create User'}
          </button>
        </form>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <Users className="w-4 h-4 text-surface-400" />
          <span>Registered Users ({users.length})</span>
        </h3>
        <div className="space-y-2">
          {users.map((u) => (
            <div
              key={u.id}
              className="glass-card p-4 flex items-center justify-between"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-accent/15 border border-accent/25 text-accent font-bold text-xs flex items-center justify-center">
                  {(u.username || 'U')[0].toUpperCase()}
                </div>
                <div>
                  <span className="font-semibold text-sm text-white">
                    {u.username}
                  </span>
                  {u.is_admin && (
                    <span className="ml-2 text-[10px] font-bold uppercase tracking-wider bg-accent/20 text-accent px-2 py-0.5 rounded-full border border-accent/30">
                      admin
                    </span>
                  )}
                </div>
              </div>
              <span className="text-xs text-surface-500 font-mono">
                {new Date(u.created_at).toLocaleDateString()}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
