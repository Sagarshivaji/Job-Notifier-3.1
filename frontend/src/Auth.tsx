import { useState } from 'react';

export default function Auth({ onLogin }: { onLogin: (token: string, username: string, userId: number, isAdmin?: boolean) => void }) {
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [requires2FA, setRequires2FA] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [otpToken, setOtpToken] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Render's free tier spins the backend down after inactivity; a cold start can take
  // 30-60s. Without this, the first request just hangs and looks broken, so visitors
  // bail before an account is ever created. Surface it after a few seconds instead.
  const [wakingServer, setWakingServer] = useState(false);

  const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    setWakingServer(false);
    const wakeTimer = setTimeout(() => setWakingServer(true), 4000);

    try {
      const endpoint = isLogin ? '/auth/login' : '/auth/register';
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await res.json();

      if (data.success) {
        if (data.requires2FA) {
          setRequires2FA(true);
          setOtpToken(data.otpToken);
        } else {
          onLogin(data.token, data.user.username, data.user.id, Boolean(data.user.is_admin));
        }
      } else {
        setError(data.error || 'Authentication failed');
      }
    } catch (err: any) {
      setError('Network error: ' + err.message);
    } finally {
      clearTimeout(wakeTimer);
      setWakingServer(false);
      setLoading(false);
    }
  };

  const handleVerifyOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE}/auth/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otpToken, otpCode })
      });
      const data = await res.json();
      if (data.success) {
        onLogin(data.token, data.user.username, data.user.id, Boolean(data.user.is_admin));
      } else {
        setError(data.error || 'Verification failed');
      }
    } catch (err: any) {
      setError('Network error: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', background: 'var(--bg-color)' }}>
      <div className="glass-card" style={{ width: '400px', maxWidth: '90%' }}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <span className="material-symbols-outlined" style={{ fontSize: '3rem', color: 'var(--primary)' }}>bolt</span>
          <h2>Job Notification</h2>
          <p style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>{isLogin ? 'Sign in to your dashboard' : 'Create a new account'}</p>
          
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: '1.5', background: 'var(--bg-input)', padding: '1rem', borderRadius: '8px', marginBottom: '1.5rem', textAlign: 'left', border: '1px solid var(--border-color)' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Why use Job Notification?</strong>
            <ul style={{ paddingLeft: '1.25rem', marginTop: '0.5rem', marginBottom: 0 }}>
              <li>Automatically scan 10+ platforms 24/7 in the background.</li>
              <li>Filter jobs by exact keywords, location, and remote status.</li>
              <li>Get instant push notifications straight to your phone.</li>
            </ul>
          </div>
        </div>

        {error && (
          <div style={{ background: 'rgba(255, 77, 79, 0.1)', color: '#ff4d4f', padding: '0.75rem', borderRadius: '8px', marginBottom: '1rem', border: '1px solid rgba(255, 77, 79, 0.3)' }}>
            {error}
          </div>
        )}

        {requires2FA ? (
          <form onSubmit={handleVerifyOTP}>
            <div className="form-group">
              <label className="form-label">Check your Email for a 6-digit Code</label>
              <input 
                type="text" 
                className="form-input" 
                placeholder="000000"
                value={otpCode}
                onChange={e => setOtpCode(e.target.value)}
                maxLength={6}
                required
                style={{ textAlign: 'center', fontSize: '1.25rem', letterSpacing: '4px' }}
              />
            </div>
            <button className="btn" style={{ width: '100%', marginTop: '1rem' }} disabled={loading}>
              {loading ? 'Verifying...' : 'Verify Secure Login'}
            </button>
            <div style={{ textAlign: 'center', marginTop: '1rem' }}>
              <button 
                type="button"
                className="btn btn-secondary" 
                style={{ border: 'none', background: 'transparent' }}
                onClick={() => {
                  setRequires2FA(false);
                  setOtpCode('');
                  setOtpToken(null);
                }}
              >
                Back to Login
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label">Username</label>
              <input 
                type="text" 
                className="form-input" 
                value={username}
                onChange={e => setUsername(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label">Password</label>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <input 
                  type={showPassword ? 'text' : 'password'} 
                  className="form-input" 
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  style={{ paddingRight: '2.5rem', width: '100%' }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  style={{
                    position: 'absolute',
                    right: '0.75rem',
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0
                  }}
                  title={showPassword ? 'Hide password' : 'Show password'}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '1.25rem' }}>
                    {showPassword ? 'visibility_off' : 'visibility'}
                  </span>
                </button>
              </div>
            </div>

            <button className="btn" style={{ width: '100%', marginTop: '1rem' }} disabled={loading}>
              {loading ? (wakingServer ? 'Waking up server...' : 'Please wait...') : (isLogin ? 'Login' : 'Register')}
            </button>

            {wakingServer && (
              <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', textAlign: 'center', marginTop: '0.75rem', lineHeight: '1.4' }}>
                The server was asleep and is starting back up — this can take up to a minute on the first try. Please don't refresh, it will finish shortly.
              </div>
            )}

            <div style={{ textAlign: 'center', marginTop: '1.5rem' }}>
              <button 
                type="button"
                className="btn btn-secondary" 
                style={{ border: 'none', background: 'transparent' }}
                onClick={() => setIsLogin(!isLogin)}
              >
                {isLogin ? "Don't have an account? Register" : "Already have an account? Login"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
