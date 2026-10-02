import { useState, useEffect, useRef } from 'react';

const API_URL = window.location.origin;

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [myName, setMyName] = useState('');
  const [myId, setMyId] = useState(null);
  const [users, setUsers] = useState([]);
  const [callState, setCallState] = useState('idle');
  const [currentCall, setCurrentCall] = useState(null);
  const [callTimer, setCallTimer] = useState(0);
  const [incomingCall, setIncomingCall] = useState(null);
  const [toast, setToast] = useState(null);

  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const callTimerRef = useRef(null);
  const pollingRef = useRef(null);
  const checkCallIntervalRef = useRef(null);

  function showToast(message, type = '') {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }

  // Fetch users
  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const res = await fetch(`${API_URL}/api/users`);
        const allUsers = await res.json();
        setUsers(allUsers.filter(u => u.id !== myId && u.name));
      } catch (err) {
        // Ignore
      }
    };
    fetchUsers();
    const interval = setInterval(fetchUsers, 2000);
    return () => clearInterval(interval);
  }, [myId]);

  // Poll for incoming calls
  useEffect(() => {
    if (!myId) return;

    const checkIncoming = async () => {
      try {
        const res = await fetch(`${API_URL}/api/users`, { signal: AbortSignal.timeout(5000) });
        const allUsers = await res.json();
        
        for (const user of allUsers) {
          if (user.id === myId) continue;
          const callId = `${Math.min(user.id, myId)}-${Math.max(user.id, myId)}`;
          
          try {
            const roomRes = await fetch(`${API_URL}/api/rooms/${callId}`);
            const room = await roomRes.json();
            if (room.state === 'offered' && room.from === user.id) {
              setIncomingCall({
                callId,
                fromId: user.id,
                fromName: room.fromName || user.name
              });
              showToast(`${user.name} is calling`, 'success');
              break;
            }
          } catch {}
        }
      } catch {}
    };
    checkCallIntervalRef.current = setInterval(checkIncoming, 3000);
    return () => clearInterval(checkCallIntervalRef.current);
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
    .catch(err => showToast('Failed to connect', 'error'));
  }

  // Call someone
  async function startCall(targetUserId, targetUserName) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;

      // Shared call ID: both caller and receiver know the IDs, so they can derive it
      const callId = `${Math.min(myId, targetUserId)}-${Math.max(myId, targetUserId)}`;
      setCallState('calling');
      setCurrentCall({ to: targetUserId, toName: targetUserName, callId, isOutgoing: true });

      const pc = createPeerConnection();
      peerConnectionRef.current = pc;

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await new Promise(resolve => setTimeout(resolve, 500));

      await fetch(`${API_URL}/api/rooms/${callId}/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callId, offer: pc.localDescription, from: myId, to: targetUserId,
          fromName: myName
        })
      }).catch(() => {});

      pollForAnswer(callId);

    } catch (err) {
      console.error('Error starting call:', err);
      showToast('Microphone access denied', 'error');
    }
  }

  function createPeerConnection() {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
      ],
    });

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => pc.addTrack(track, localStreamRef.current));
    }

    pc.onicecandidate = (event) => {
      if (event.candidate && currentCall) {
        fetch(`${API_URL}/api/rooms/${currentCall.callId}/ice`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            callId: currentCall.callId,
            candidate: event.candidate,
            from: myId,
            to: currentCall.to
          })
        }).catch(() => {});
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

    return pc;
  }

  // Poll for answer (caller side)
  function pollForAnswer(callId) {
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
        } else if (room.state === 'ended' || room.state === 'declined') {
          endCall();
          if (room.state === 'declined') showToast('Call declined', 'error');
        } else {
          pollingRef.current = setTimeout(poll, 1500);
        }
      } catch {
        pollingRef.current = setTimeout(poll, 1500);
      }
    };
    poll();
  }

  // Answer an incoming call
  async function acceptCall(callId, fromUserId, fromUserName) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;

      const pc = createPeerConnection();
      peerConnectionRef.current = pc;

      setCallState('connected');
      setCurrentCall({ to: fromUserId, toName: fromUserName, callId, isOutgoing: false });

      // Get the offer from the room
      const res = await fetch(`${API_URL}/api/rooms/${callId}`);
      const room = await res.json();

      await pc.setRemoteDescription(new RTCSessionDescription(room.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      await fetch(`${API_URL}/api/rooms/${callId}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callId, answer: pc.localDescription, from: myId, to: fromUserId
        })
      }).catch(() => {});

      startCallTimer();
      setIncomingCall(null);

    } catch (err) {
      console.error('Error answering call:', err);
      setIncomingCall(null);
    }
  }

  function declineCall() {
    if (incomingCall && incomingCall.callId) {
      // Mark the room as declined
      const fetchDecline = async () => {
        try {
          const res = await fetch(`${API_URL}/api/rooms/${incomingCall.callId}`);
          const room = await res.json();
          room.state = 'declined';
        } catch {}
      };
      fetchDecline();
    }
    setIncomingCall(null);
    showToast('Call declined', 'error');
  }

  function cancelCall() {
    if (currentCall) {
      fetch(`${API_URL}/api/rooms/${currentCall.callId}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: currentCall.callId })
      }).catch(() => {});
    }
    cleanupCall();
  }

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
    setIncomingCall(null);
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
    if (checkCallIntervalRef.current) {
      clearInterval(checkCallIntervalRef.current);
    }
    setIsLoggedIn(false);
    setMyName('');
    setMyId(null);
    setUsers([]);
    setIncomingCall(null);
    setCallState('idle');
    setCurrentCall(null);
    setCallTimer(0);
    setToast(null);
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

      {/* Incoming Call Screen */}
      {incomingCall && (
        <div className="call-screen incoming-call-screen">
          <div className="call-screen-avatar incoming-pulse">
            {incomingCall.fromName.charAt(0).toUpperCase()}
          </div>
          
          <div className="call-screen-name">
            {incomingCall.fromName}
          </div>
          
          <div className="call-screen-status" style={{ color: '#4ade80', marginBottom: '40px' }}>
            Incoming call...
          </div>
          
          <div className="call-screen-controls incoming-controls">
            <button className="call-screen-hangup" style={{ background: 'linear-gradient(135deg, #00c853, #009624)' }} onClick={() => acceptCall(incomingCall.callId, incomingCall.fromId, incomingCall.fromName)}>
              <span className="hangup-icon">✓</span>
              <span>Answer</span>
            </button>
            <button className="call-screen-cancel" onClick={declineCall}>
              ✕ Decline
            </button>
          </div>
        </div>
      )}

      {/* Calling/Connecting Screen */}
      {(callState === 'calling' || callState === 'connecting') && currentCall && (
        <div className="call-screen">
          <div className="call-screen-header">
            <span className="call-screen-status">
              {callState === 'calling' ? '📞 Calling...' : '🔗 Connecting...'}
            </span>
          </div>
          
          <div className="call-screen-avatar">
            {currentCall.toName.charAt(0).toUpperCase()}
          </div>
          
          <div className="call-screen-name">
            {currentCall.toName}
          </div>
          
          <button className="call-screen-cancel" onClick={cancelCall}>
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

      {/* Users List */}
      {callState === 'idle' && !incomingCall && (
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
                Open the same link in another browser/tab with a different name
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
