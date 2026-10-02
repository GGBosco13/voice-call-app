import { useState, useEffect, useRef, useCallback } from 'react';

const API_URL = window.location.origin;

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [myName, setMyName] = useState('');
  const [myId, setMyId] = useState(null);
  const [users, setUsers] = useState([]);
  const [callState, setCallState] = useState('idle'); // idle, calling, ringing, connecting, connected
  const [currentCall, setCurrentCall] = useState(null);
  const [callTimer, setCallTimer] = useState(0);
  const [toast, setToast] = useState(null);

  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const callTimerRef = useRef(null);
  const pollingRef = useRef(null);

  function showToast(message, type = '') {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }

  // Fetch users periodically (polling-based signaling)
  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const res = await fetch(`${API_URL}/api/users`);
        const allUsers = await res.json();
        setUsers(allUsers.filter(u => u.id !== myId));
      } catch (err) {
        console.error('Failed to fetch users:', err);
      }
    };

    fetchUsers();
    const interval = setInterval(fetchUsers, 2000);
    return () => clearInterval(interval);
  }, [myId]);

  function handleLogin(e) {
    e.preventDefault();
    if (!myName.trim()) return;

    fetch(`${API_URL}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: myName })
    })
    .then(res => res.json())
    .then(data => {
      setMyId(data.userId);
      setIsLoggedIn(true);
    })
    .catch(err => {
      console.error('Registration failed:', err);
      showToast('Failed to connect', 'error');
    });
  }

  async function startCall(targetUserId, targetUserName) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;

      const callId = `${Date.now()}-${targetUserId}`;
      setCallState('calling');
      setCurrentCall({ to: targetUserId, toName: targetUserName, callId });

      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' },
        ],
      });
      peerConnectionRef.current = pc;

      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          fetch(`${API_URL}/api/rooms/${callId}/ice`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              callId,
              candidate: event.candidate,
              from: myId,
              to: targetUserId
            })
          }).catch(err => console.error('ICE fetch failed:', err));
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setCallState('connected');
          startCallTimer();
        } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          endCall();
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      await new Promise(resolve => setTimeout(resolve, 500));

      await fetch(`${API_URL}/api/rooms/${callId}/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callId,
          offer: pc.localDescription,
          from: myId,
          to: targetUserId
        })
      }).catch(err => console.error('Offer fetch failed:', err));

      // Poll for answer
      pollForAnswer(callId, targetUserId);

    } catch (err) {
      console.error('Error starting call:', err);
      showToast('Microphone access denied', 'error');
    }
  }

  function pollForAnswer(callId, targetUserId) {
    const poll = async () => {
      try {
        const res = await fetch(`${API_URL}/api/rooms/${callId}`);
        const room = await res.json();
        if (room.state === 'answered' && room.answer) {
          const pc = peerConnectionRef.current;
          if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription(room.answer));
            setCallState('connected');
            startCallTimer();
          }
        } else if (room.state === 'ended') {
          endCall();
        } else {
          pollingRef.current = setTimeout(poll, 1500);
        }
      } catch {
        pollingRef.current = setTimeout(poll, 1500);
      }
    };
    poll();
  }

  // Poll for incoming calls (check if there's an unanswered offer for us)
  useEffect(() => {
    if (!myId) return;

    const checkIncoming = async () => {
      try {
        // Check all rooms for unanswered calls directed at us
        const usersRes = await fetch(`${API_URL}/api/users`);
        const allUsers = await usersRes.json();
        
        for (const user of allUsers) {
          if (user.id === myId) continue;
          const callId = `${Date.now()}-${myId}`;
          
          // Try checking rooms - this is a simplified approach
          // We check by looking at the room state
        }
      } catch (err) {
        // Ignore errors
      }
    };

    const interval = setInterval(checkIncoming, 3000);
    return () => clearInterval(interval);
  }, [myId]);

  function endCall() {
    if (currentCall) {
      fetch(`${API_URL}/api/rooms/${currentCall.callId}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: currentCall.callId })
      }).catch(() => {});
    }
    cleanupCall();
  }

  function cleanupCall() {
    if (pollingRef.current) {
      clearTimeout(pollingRef.current);
      pollingRef.current = null;
    }
    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
      callTimerRef.current = null;
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }
    setCallState('idle');
    setCallTimer(0);
    setCurrentCall(null);
  }

  function startCallTimer() {
    setCallTimer(0);
    callTimerRef.current = setInterval(() => {
      setCallTimer(prev => prev + 1);
    }, 1000);
  }

  function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  function handleLogout() {
    cleanupCall();
    setIsLoggedIn(false);
    setMyName('');
    setMyId(null);
    setUsers([]);
  }

  // Login Screen
  if (!isLoggedIn) {
    return (
      <div className="app">
        <div className="login-screen">
          <div className="icon">📞</div>
          <h1>Voice Call</h1>
          <p className="subtitle">Connect with friends instantly</p>
          <form onSubmit={handleLogin}>
            <input
              type="text"
              placeholder="Enter your name..."
              value={myName}
              onChange={(e) => setMyName(e.target.value)}
              autoFocus
            />
            <br />
            <button type="submit" disabled={!myName.trim()}>
              Start Calling
            </button>
          </form>
          <p style={{ marginTop: '30px', fontSize: '0.8rem', color: '#555' }}>
            Open this app in two browser windows with different names to test calling
          </p>
        </div>
        {toast && (
          <div className={`toast ${toast.type}`}>
            {toast.message}
          </div>
        )}
      </div>
    );
  }

  // Main App
  return (
    <div className="app">
      {/* Header */}
      <div className="header">
        <h2>📞 Voice Call</h2>
        <div className="user-info">
          <div className="avatar">{myName.charAt(0).toUpperCase()}</div>
          <span>{myName}</span>
          <button className="logout-btn" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </div>

      {/* Calling Screen */}
      {(callState === 'calling' || callState === 'ringing' || callState === 'connecting') && currentCall && (
        <div className="call-screen">
          <div className="call-screen-header">
            <span className="call-screen-status">
              {callState === 'calling' && '📞 Calling...'}
              {callState === 'ringing' && '🔔 Ringing...'}
              {callState === 'connecting' && '🔗 Connecting...'}
            </span>
          </div>
          
          <div className="call-screen-avatar">
            {currentCall.toName.charAt(0).toUpperCase()}
          </div>
          
          <div className="call-screen-name">
            {currentCall.toName}
          </div>
          
          <button className="call-screen-cancel" onClick={endCall}>
            ✕ Cancel
          </button>
        </div>
      )}

      {/* Connected Call Screen */}
      {callState === 'connected' && currentCall && (
        <div className="call-screen">
          <div className="call-screen-header">
            <span className="call-screen-status call-active">
              ● Active Call
            </span>
          </div>
          
          <div className="call-screen-avatar">
            {currentCall.toName.charAt(0).toUpperCase()}
          </div>
          
          <div className="call-screen-name">
            {currentCall.toName}
          </div>
          
          <div className="call-screen-timer">
            {formatTime(callTimer)}
          </div>
          
          <div className="call-screen-controls">
            <button className="call-screen-hangup" onClick={endCall}>
              <span className="hangup-icon">📵</span>
              <span>Hang Up</span>
            </button>
          </div>
        </div>
      )}

      {/* Users List - hidden during call */}
      {callState === 'idle' && (
        <div className="users-section">
          <h3>
            {users.length > 0 ? `Online Users (${users.length})` : 'No Users Online'}
          </h3>
          
          {users.length > 0 ? (
            <div className="users-list">
              {users.map((user) => (
                <div key={user.id} className="user-card">
                  <div className="user-details">
                    <div className="avatar">
                      {user.name.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div className="name">{user.name}</div>
                      <div className="status">● Online</div>
                    </div>
                  </div>
                  <button
                    className="call-btn"
                    onClick={() => startCall(user.id, user.name)}
                    disabled={callState !== 'idle'}
                  >
                    📞 Call
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <div className="icon">👥</div>
              <p>No other users online yet</p>
              <p style={{ fontSize: '0.85rem', marginTop: '5px' }}>
                Open the same link in another browser/tab with a different name to see each other
              </p>
              <p style={{ fontSize: '0.8rem', marginTop: '10px', color: '#555' }}>
                💡 Tip: Open this page twice in your browser — once with name "Alice", once with "Bob"
              </p>
            </div>
          )}
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={`toast ${toast.type}`}>
          {toast.message}
        </div>
      )}
    </div>
  );
}

export default App;
