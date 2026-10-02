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
  const connectedTimerRef = useRef(null);
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

  // Poll for incoming calls and ICE candidates
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

  // Poll for ICE candidates during an active call
  useEffect(() => {
    if (!currentCall) return;

    const pollICE = async () => {
      try {
        const res = await fetch(`${API_URL}/api/rooms/${currentCall.callId}`);
        const room = await res.json();
        if (room.iceCandidates && peerConnectionRef.current) {
          if (!peerConnectionRef.current._addedIce) peerConnectionRef.current._addedIce = new Set();
          for (const ice of room.iceCandidates) {
            const candidateObj = ice.candidate || ice;
            const key = typeof candidateObj === 'string' 
              ? candidateObj 
              : JSON.stringify({ candidate: candidateObj.candidate, sdpMid: candidateObj.sdpMid, sdpMLineIndex: candidateObj.sdpMLineIndex });
            if (!peerConnectionRef.current._addedIce.has(key)) {
              peerConnectionRef.current._addedIce.add(key);
              try {
                await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidateObj));
              } catch (e) {
                console.warn('Failed to add ICE candidate:', e);
              }
            }
          }
        }
      } catch (e) {
        console.warn('ICE poll failed:', e);
      }
    };
    const interval = setInterval(pollICE, 1000);
    pollICE();
    return () => clearInterval(interval);
  }, [currentCall?.callId, callState, myId]);

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
      console.error('Register failed:', err);
      showToast('Failed to connect', 'error');
    });
  }

  // Call someone
  async function startCall(targetUserId, targetUserName) {
    try {
      console.log('Requesting microphone access...');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('Microphone access granted, tracks:', stream.getTracks().length);
      localStreamRef.current = stream;

      const callId = `${Math.min(myId, targetUserId)}-${Math.max(myId, targetUserId)}`;
      setCallState('calling');
      setCurrentCall({ to: targetUserId, toName: targetUserName, callId, isOutgoing: true });

      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          { urls: 'stun:stun3.l.google.com:19302' },
          { urls: 'stun:stun4.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' },
          { urls: 'stun:global.stun.twilio.com:3478?transport=udp' },
          {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
          {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
          {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
          {
            urls: 'turns:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
        ],
      });
      peerConnectionRef.current = pc;

      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      // ICE candidates: send each one as it's gathered
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log('Caller: ICE candidate gathered, sending to server');
          fetch(`${API_URL}/api/rooms/${callId}/ice`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              callId, candidate: event.candidate, from: myId, to: targetUserId
            })
          }).catch(() => {});
        }
      };

      // Receive remote audio track
      pc.ontrack = (event) => {
        console.log('Caller: ontrack received, remote tracks:', event.streams[0]?.getTracks().length);
        if (peerConnectionRef.current._remoteAudio) {
          try { peerConnectionRef.current._remoteAudio.pause(); } catch {}
          try { peerConnectionRef.current._remoteAudio.remove(); } catch {}
        }
        const audio = document.createElement('audio');
        audio.autoplay = true;
        audio.playsInline = true;
        audio.srcObject = event.streams[0];
        audio.play().then(() => {
          console.log('Caller: remote audio playing');
        }).catch((e) => {
          console.warn('Caller: autoplay blocked:', e);
        });
        document.body.appendChild(audio);
        peerConnectionRef.current._remoteAudio = audio;
      };

      pc.onconnectionstatechange = () => {
        console.log('Caller: connectionState=', pc.connectionState, 'ice=', pc.iceConnectionState);
        if (pc.connectionState === 'connected') {
          setCallState('connected');
          startCallTimer();
        } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') {
          console.log('Caller: call failed, ending');
          endCall();
        }
      };

      // Create offer and wait for ICE gathering to complete (includes TURN candidates in SDP)
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.log('Caller: waiting for ICE gathering...');

      await new Promise((resolve) => {
        const checkDone = () => {
          if (pc.iceGatheringState === 'complete') {
            console.log('Caller: ICE gathering complete!');
            resolve();
          }
        };
        const interval = setInterval(checkDone, 100);
        setTimeout(() => {
          clearInterval(interval);
          console.log('Caller: ICE gathering timeout, sending anyway');
          resolve();
        }, 8000);
        checkDone();
      });

      console.log('Caller: sending offer with full ICE info');
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
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        showToast('Microphone access denied. Please allow in browser settings.', 'error');
      } else {
        showToast('Failed to start call: ' + err.message, 'error');
      }
    }
  }

  function createPeerConnection() {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
        { urls: 'stun:stun.l.google.com:19302?transport=udp' },
        { urls: 'stun:stun.l.google.com:19302?transport=tcp' },
        { urls: 'stun:stun.l.google.com:19302?transport=tls' },
        {
          urls: 'turn:openrelay.metered.ca:443',
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
        {
          urls: 'turn:openrelay.metered.ca:80',
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
        {
          urls: 'turn:openrelay.metered.ca:443?transport=tcp',
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
        {
          urls: 'turns:openrelay.metered.ca:443?transport=tcp',
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
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
        console.log('pollForAnswer: room state =', room.state);
        if (room.state === 'answered' && room.answer) {
          const pc = peerConnectionRef.current;
          if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription({
              type: 'answer',
              sdp: room.answer.sdp || room.answer
            }));
            console.log('Caller set remote description (answer), waiting for connection...');
            // Don't set connected here - let onconnectionstatechange handle it
            // Keep polling for the actual connection state
            return; // Stop polling once we got the answer
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
      console.log('acceptCall: requesting microphone...');
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log('acceptCall: mic granted, tracks:', stream.getTracks().length);
      } catch (micErr) {
        console.error('acceptCall: mic denied', micErr);
        showToast('Microphone access denied. Please allow in browser settings.', 'error');
        setIncomingCall(null);
        return;
      }
      localStreamRef.current = stream;

      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          { urls: 'stun:stun3.l.google.com:19302' },
          { urls: 'stun:stun4.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' },
          {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
          {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
          {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
          {
            urls: 'turns:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
        ],
      });
      peerConnectionRef.current = pc;

      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log('Callee: ICE candidate gathered, sending to server');
          fetch(`${API_URL}/api/rooms/${callId}/ice`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callId, candidate: event.candidate, from: myId, to: fromUserId })
          }).catch(() => {});
        }
      };

      pc.ontrack = (event) => {
        console.log('Callee: ontrack received, remote tracks:', event.streams[0]?.getTracks().length);
        if (peerConnectionRef.current._remoteAudio) {
          try { peerConnectionRef.current._remoteAudio.pause(); } catch {}
          try { peerConnectionRef.current._remoteAudio.remove(); } catch {}
        }
        const audio = document.createElement('audio');
        audio.autoplay = true;
        audio.playsInline = true;
        audio.srcObject = event.streams[0];
        audio.play().then(() => {
          console.log('Callee: remote audio playing');
        }).catch((e) => {
          console.warn('Callee: autoplay blocked:', e);
        });
        document.body.appendChild(audio);
        peerConnectionRef.current._remoteAudio = audio;
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        const iceState = pc.iceConnectionState;
        console.log('Callee: connectionState=', state, 'ice=', iceState);
        if (state === 'connected') {
          setCallState('connected');
          startCallTimer();
        } else if (state === 'disconnected' || state === 'failed' || iceState === 'failed') {
          console.log('Callee: call failed, ending');
          endCall();
        }
      };

      // Get the offer and pending ICE from the room
      const res = await fetch(`${API_URL}/api/rooms/${callId}`);
      const room = await res.json();

      // Pre-add any pending ICE candidates from the caller
      if (room.iceCandidates) {
        for (const ice of room.iceCandidates) {
          const candidateObj = ice.candidate || ice;
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidateObj));
          } catch (e) {
            console.warn('Failed to add pre-fetched ICE candidate:', e);
          }
        }
      }

      await pc.setRemoteDescription(new RTCSessionDescription({
        type: 'offer',
        sdp: room.offer.sdp || room.offer
      }));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Wait for ICE gathering before sending the answer (so TURN candidates are included in SDP)
      console.log('Callee: waiting for ICE gathering...');
      await new Promise((resolve) => {
        const checkDone = () => {
          if (pc.iceGatheringState === 'complete') {
            console.log('Callee: ICE gathering complete!');
            resolve();
          }
        };
        const interval = setInterval(checkDone, 100);
        setTimeout(() => {
          clearInterval(interval);
          console.log('Callee: ICE gathering timeout, sending anyway');
          resolve();
        }, 8000);
        checkDone();
      });

      console.log('Callee: sending answer with full ICE info');
      await fetch(`${API_URL}/api/rooms/${callId}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId, answer: pc.localDescription, from: myId, to: fromUserId })
      }).catch(() => {});

      setCurrentCall({ to: fromUserId, toName: fromUserName, callId, isOutgoing: false });
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
      if (peerConnectionRef.current._remoteAudio) {
        peerConnectionRef.current._remoteAudio.pause();
        peerConnectionRef.current._remoteAudio.srcObject = null;
      }
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
