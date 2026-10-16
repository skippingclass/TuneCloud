import { useState, useEffect } from 'react';
import {
  Shield,
  ShieldCheck,
  UserPlus,
  Users,
  KeyRound,
  Eye,
  EyeOff,
  Copy,
  Check,
  Trash2,
  X,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import { api } from '../api.js';
import { toast } from '../components/layout/Toast.jsx';

export function AdminView({ user: currentUser }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  // Create user form state
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newIsAdmin, setNewIsAdmin] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Password visibility map (userId -> boolean)
  const [showPasswordMap, setShowPasswordMap] = useState({});

  // Password copied feedback map (userId -> boolean)
  const [copiedMap, setCopiedMap] = useState({});

  // Change password modal state
  const [passwordModalUser, setPasswordModalUser] = useState(null);
  const [changedPassword, setChangedPassword] = useState('');
  const [showChangedPassword, setShowChangedPassword] = useState(false);
  const [changePasswordLoading, setChangePasswordLoading] = useState(false);

  // Delete user confirmation modal
  const [deleteModalUser, setDeleteModalUser] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const loadUsers = async () => {
    try {
      const data = await api.adminUsers();
      setUsers(Array.isArray(data) ? data : []);
    } catch (err) {
      toast(`Failed to load users: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, []);

  const handleTogglePassword = (userId) => {
    setShowPasswordMap((prev) => ({ ...prev, [userId]: !prev[userId] }));
  };

  const handleCopyPassword = (userId, password) => {
    if (!password) {
      toast('No plaintext password available for this account', 'error');
      return;
    }
    navigator.clipboard.writeText(password).then(() => {
      setCopiedMap((prev) => ({ ...prev, [userId]: true }));
      toast('Password copied to clipboard', 'success');
      setTimeout(() => {
        setCopiedMap((prev) => ({ ...prev, [userId]: false }));
      }, 2000);
    });
  };

  const handleCreateUser = async (e) => {
    e.preventDefault();
    if (!newUsername || !newPassword) return;
    if (newPassword.length < 8) {
      toast('Password must be at least 8 characters long', 'error');
      return;
    }

    setCreateLoading(true);
    try {
      await api.register(newUsername, newPassword);
      if (newIsAdmin) {
        // Find new user id to promote
        const updated = await api.adminUsers();
        const createdUser = updated.find((u) => u.username === newUsername.trim());
        if (createdUser) {
          await api.adminToggleAdmin(createdUser.id, true);
        }
      }
      toast(`User "${newUsername}" created successfully`, 'success');
      setNewUsername('');
      setNewPassword('');
      setNewIsAdmin(false);
      setShowCreateModal(false);
      loadUsers();
    } catch (err) {
      toast(err.message || 'Failed to create user', 'error');
    } finally {
      setCreateLoading(false);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (!passwordModalUser || !changedPassword) return;
    if (changedPassword.length < 8) {
      toast('Password must be at least 8 characters long', 'error');
      return;
    }

    setChangePasswordLoading(true);
    try {
      await api.adminChangePassword(passwordModalUser.id, changedPassword);
      toast(`Password updated for "${passwordModalUser.username}"`, 'success');
      setPasswordModalUser(null);
      setChangedPassword('');
      loadUsers();
    } catch (err) {
      toast(err.message || 'Failed to update password', 'error');
    } finally {
      setChangePasswordLoading(false);
    }
  };

  const handleToggleAdmin = async (targetUser) => {
    if (targetUser.id === currentUser?.id && targetUser.is_admin) {
      toast('Cannot remove admin privileges from yourself', 'error');
      return;
    }
    const nextState = !targetUser.is_admin;
    try {
      await api.adminToggleAdmin(targetUser.id, nextState);
      toast(
        nextState
          ? `Granted administrator role to "${targetUser.username}"`
          : `Revoked administrator role from "${targetUser.username}"`,
        'success'
      );
      loadUsers();
    } catch (err) {
      toast(err.message || 'Failed to update admin role', 'error');
    }
  };

  const handleDeleteUser = async () => {
    if (!deleteModalUser) return;
    if (deleteModalUser.id === currentUser?.id) {
      toast('Cannot delete your own account', 'error');
      return;
    }

    setDeleteLoading(true);
    try {
      await api.adminDeleteUser(deleteModalUser.id);
      toast(`User "${deleteModalUser.username}" has been deleted`, 'success');
      setDeleteModalUser(null);
      loadUsers();
    } catch (err) {
      toast(err.message || 'Failed to delete user', 'error');
    } finally {
      setDeleteLoading(false);
    }
  };

  const adminCount = users.filter((u) => u.is_admin).length;

  return (
    <div className="max-w-4xl space-y-7 animate-fade-in pb-12">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2.5">
            <Shield className="w-6 h-6 text-accent" />
            <span>Admin — User Management</span>
          </h1>
          <p className="text-xs text-surface-400 mt-1">
            Manage TuneCloud accounts, view or change passwords, and configure access permissions.
          </p>
        </div>

        <button
          onClick={() => setShowCreateModal(true)}
          className="btn-primary px-4 py-2 text-xs flex items-center gap-2 self-start sm:self-auto shrink-0"
        >
          <UserPlus className="w-4 h-4" />
          <span>Add New User</span>
        </button>
      </div>

      {/* Metrics overview */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3.5">
        <div className="glass-panel p-4 rounded-2xl border border-white/[0.08] flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/25 text-accent flex items-center justify-center shrink-0">
            <Users className="w-5 h-5" />
          </div>
          <div>
            <span className="text-[11px] text-surface-400 block font-medium">Total Accounts</span>
            <span className="text-xl font-bold text-white tracking-tight">{users.length}</span>
          </div>
        </div>

        <div className="glass-panel p-4 rounded-2xl border border-white/[0.08] flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-purple-500/15 border border-purple-500/25 text-purple-400 flex items-center justify-center shrink-0">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <span className="text-[11px] text-surface-400 block font-medium">Administrators</span>
            <span className="text-xl font-bold text-white tracking-tight">{adminCount}</span>
          </div>
        </div>

        <div className="glass-panel p-4 rounded-2xl border border-white/[0.08] col-span-2 sm:col-span-1 flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/25 text-emerald-400 flex items-center justify-center shrink-0">
            <KeyRound className="w-5 h-5" />
          </div>
          <div>
            <span className="text-[11px] text-surface-400 block font-medium">Subsonic Secrets</span>
            <span className="text-xl font-bold text-white tracking-tight">
              {users.filter((u) => !!u.password).length} Active
            </span>
          </div>
        </div>
      </div>

      {/* Users List Section */}
      <div className="glass-panel p-5 sm:p-6 rounded-3xl border border-white/[0.08] space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <Users className="w-4 h-4 text-surface-400" />
            <span>Registered Accounts</span>
          </h2>
          <span className="text-xs text-surface-500 font-mono">
            {users.length} {users.length === 1 ? 'user' : 'users'}
          </span>
        </div>

        {loading ? (
          <div className="py-12 flex flex-col items-center justify-center gap-3 text-surface-400">
            <Loader2 className="w-7 h-7 animate-spin text-accent" />
            <span className="text-xs">Loading accounts...</span>
          </div>
        ) : users.length === 0 ? (
          <div className="py-10 text-center text-surface-500 text-xs">
            No registered users found.
          </div>
        ) : (
          <div className="space-y-2.5">
            {users.map((u) => {
              const isCurrent = currentUser?.id === u.id;
              const isPasswordVisible = !!showPasswordMap[u.id];
              const isCopied = !!copiedMap[u.id];

              return (
                <div
                  key={u.id}
                  className="p-4 rounded-2xl bg-white/[0.025] hover:bg-white/[0.045] border border-white/[0.06] hover:border-white/[0.1] transition-all flex flex-col md:flex-row md:items-center justify-between gap-4"
                >
                  {/* Left: User identity & role */}
                  <div className="flex items-center gap-3.5 min-w-0">
                    <div className="w-10 h-10 rounded-full bg-accent/15 border border-accent/25 text-accent font-bold text-sm flex items-center justify-center shrink-0">
                      {(u.username || 'U')[0].toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm text-white truncate">
                          {u.username}
                        </span>
                        {isCurrent && (
                          <span className="text-[10px] font-bold uppercase tracking-wider bg-white/10 text-white/90 px-2 py-0.5 rounded-full border border-white/15">
                            You
                          </span>
                        )}
                        {u.is_admin && (
                          <span className="text-[10px] font-bold uppercase tracking-wider bg-accent/20 text-accent px-2 py-0.5 rounded-full border border-accent/30 flex items-center gap-1">
                            <Shield className="w-2.5 h-2.5" />
                            <span>admin</span>
                          </span>
                        )}
                      </div>
                      <span className="text-[11px] text-surface-500 font-mono block mt-0.5">
                        Created {new Date(u.created_at).toLocaleDateString()}
                      </span>
                    </div>
                  </div>

                  {/* Middle: Plaintext password view & copy */}
                  <div className="flex items-center gap-2 bg-black/35 px-3 py-1.5 rounded-xl border border-white/[0.06] text-xs self-start md:self-auto">
                    <KeyRound className="w-3.5 h-3.5 text-surface-400 shrink-0" />
                    <span className="font-mono text-surface-300 min-w-[100px] select-all">
                      {isPasswordVisible
                        ? u.password || '<not available>'
                        : '••••••••••••'}
                    </span>
                    <button
                      onClick={() => handleTogglePassword(u.id)}
                      title={isPasswordVisible ? 'Hide password' : 'Show password'}
                      className="p-1 rounded-lg text-surface-400 hover:text-white hover:bg-white/[0.08] transition-colors"
                    >
                      {isPasswordVisible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      onClick={() => handleCopyPassword(u.id, u.password)}
                      title="Copy password to clipboard"
                      className="p-1 rounded-lg text-surface-400 hover:text-white hover:bg-white/[0.08] transition-colors"
                    >
                      {isCopied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>

                  {/* Right: Actions (Change Password, Toggle Admin, Delete) */}
                  <div className="flex items-center gap-2 self-end md:self-auto">
                    {/* Change Password */}
                    <button
                      onClick={() => {
                        setPasswordModalUser(u);
                        setChangedPassword('');
                        setShowChangedPassword(false);
                      }}
                      title="Change user password"
                      className="px-3 py-1.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.1] border border-white/[0.08] text-surface-300 hover:text-white text-xs font-medium flex items-center gap-1.5 transition-colors"
                    >
                      <KeyRound className="w-3.5 h-3.5 text-accent" />
                      <span>Change Password</span>
                    </button>

                    {/* Toggle Admin */}
                    <button
                      onClick={() => handleToggleAdmin(u)}
                      disabled={isCurrent && u.is_admin}
                      title={
                        isCurrent && u.is_admin
                          ? 'Cannot remove admin rights from yourself'
                          : u.is_admin
                          ? 'Revoke admin role'
                          : 'Promote to admin'
                      }
                      className={`p-2 rounded-xl border text-xs font-medium transition-colors ${
                        u.is_admin
                          ? 'bg-purple-500/15 border-purple-500/30 text-purple-300 hover:bg-purple-500/25'
                          : 'bg-white/[0.04] border-white/[0.08] text-surface-400 hover:text-white hover:bg-white/[0.08]'
                      } ${isCurrent && u.is_admin ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <Shield className="w-4 h-4" />
                    </button>

                    {/* Delete User */}
                    <button
                      onClick={() => setDeleteModalUser(u)}
                      disabled={isCurrent}
                      title={isCurrent ? 'Cannot delete your own account' : 'Delete user'}
                      className={`p-2 rounded-xl border text-xs font-medium transition-colors ${
                        isCurrent
                          ? 'bg-white/[0.02] border-white/[0.04] text-surface-600 opacity-40 cursor-not-allowed'
                          : 'bg-rose-500/10 border-rose-500/20 text-rose-400 hover:bg-rose-500/20 hover:text-rose-300'
                      }`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* MODAL: Create New User */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md animate-fade-in">
          <div className="glass-panel max-w-md w-full p-6 sm:p-7 rounded-3xl border border-white/[0.12] shadow-2xl space-y-5 animate-scale-in">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <UserPlus className="w-5 h-5 text-accent" />
                <span>Create New User</span>
              </h3>
              <button
                onClick={() => setShowCreateModal(false)}
                className="p-1.5 rounded-full text-surface-400 hover:text-white hover:bg-white/[0.08] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateUser} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-surface-300 mb-1.5">
                  Username
                </label>
                <input
                  className="glass-input w-full text-sm"
                  placeholder="e.g. musiclover"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  pattern="[a-zA-Z0-9_\-.]+"
                  minLength={3}
                  maxLength={32}
                  required
                />
                <p className="text-[10px] text-surface-500 mt-1">
                  Letters, numbers, _, -, . (3-32 characters)
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-surface-300 mb-1.5">
                  Password
                </label>
                <input
                  className="glass-input w-full text-sm font-mono"
                  type="password"
                  placeholder="Min 8 characters"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  minLength={8}
                  required
                />
              </div>

              <div className="flex items-center gap-2.5 pt-1">
                <input
                  id="admin-checkbox"
                  type="checkbox"
                  checked={newIsAdmin}
                  onChange={(e) => setNewIsAdmin(e.target.checked)}
                  className="w-4 h-4 rounded bg-white/10 border-white/20 text-accent focus:ring-accent"
                />
                <label htmlFor="admin-checkbox" className="text-xs text-surface-300 font-medium select-none cursor-pointer">
                  Grant Administrator privileges
                </label>
              </div>

              <div className="flex items-center gap-2.5 pt-3">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="flex-1 py-2.5 rounded-xl border border-white/[0.08] text-xs font-medium text-surface-300 hover:text-white hover:bg-white/[0.05] transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createLoading}
                  className="btn-primary flex-1 py-2.5 text-xs justify-center"
                >
                  {createLoading ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Creating...</span>
                    </>
                  ) : (
                    <span>Create Account</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: Change User Password */}
      {passwordModalUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md animate-fade-in">
          <div className="glass-panel max-w-md w-full p-6 sm:p-7 rounded-3xl border border-white/[0.12] shadow-2xl space-y-5 animate-scale-in">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <KeyRound className="w-5 h-5 text-accent" />
                <span>Change Password</span>
              </h3>
              <button
                onClick={() => setPasswordModalUser(null)}
                className="p-1.5 rounded-full text-surface-400 hover:text-white hover:bg-white/[0.08] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-surface-400">
              Enter a new password for account <span className="font-semibold text-white">"{passwordModalUser.username}"</span>. This will update both web login and Subsonic token authentication.
            </p>

            <form onSubmit={handleChangePassword} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-surface-300 mb-1.5">
                  New Password
                </label>
                <div className="relative">
                  <input
                    className="glass-input w-full text-sm font-mono pr-10"
                    type={showChangedPassword ? 'text' : 'password'}
                    placeholder="Min 8 characters"
                    value={changedPassword}
                    onChange={(e) => setChangedPassword(e.target.value)}
                    minLength={8}
                    required
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => setShowChangedPassword((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-surface-400 hover:text-white transition-colors"
                  >
                    {showChangedPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setPasswordModalUser(null)}
                  className="flex-1 py-2.5 rounded-xl border border-white/[0.08] text-xs font-medium text-surface-300 hover:text-white hover:bg-white/[0.05] transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={changePasswordLoading}
                  className="btn-primary flex-1 py-2.5 text-xs justify-center"
                >
                  {changePasswordLoading ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Saving...</span>
                    </>
                  ) : (
                    <span>Save Password</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: Delete User Confirmation */}
      {deleteModalUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md animate-fade-in">
          <div className="glass-panel max-w-md w-full p-6 sm:p-7 rounded-3xl border border-rose-500/30 shadow-2xl space-y-5 animate-scale-in">
            <div className="flex items-center gap-3 text-rose-400">
              <div className="w-10 h-10 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-rose-400" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Delete User Account</h3>
                <span className="text-xs text-surface-400">This action cannot be undone</span>
              </div>
            </div>

            <p className="text-xs text-surface-300 leading-relaxed">
              Are you sure you want to permanently delete user <span className="font-bold text-white">"{deleteModalUser.username}"</span>? All their playlists, favorites, and play history will be removed.
            </p>

            <div className="flex items-center gap-2.5 pt-2">
              <button
                type="button"
                onClick={() => setDeleteModalUser(null)}
                className="flex-1 py-2.5 rounded-xl border border-white/[0.08] text-xs font-medium text-surface-300 hover:text-white hover:bg-white/[0.05] transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteUser}
                disabled={deleteLoading}
                className="flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs flex items-center justify-center gap-2 transition-colors shadow-lg"
              >
                {deleteLoading ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Deleting...</span>
                  </>
                ) : (
                  <span>Delete User</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
