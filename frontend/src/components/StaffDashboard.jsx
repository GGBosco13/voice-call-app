import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../hooks/useAuth';
import {
  getSocket,
  connectSocket,
  staffConnect,
  staffToggleStatus,
  staffAcceptCall,
  staffDeclineCall,
  sendSdpOffer,
  sendSdpAnswer,
  sendIceCandidate,
  requestWebrtcConfig,
} from '../utils/socket';
import { formatDuration } from '../hooks/useWebRTC';

// ============================================================
// StaffDashboard — Real-time dispatch dashboard
// Shows: Online status, incoming calls, active call panel
// Privacy: No caller PII shown — only "Anonymous Caller"
// ============================================================

export default function StaffDashboard() {
  const { staffToken, staffId, logout } = useAuth();
  const [status, setStatus] = useState('available'); // available | busy
  const [incomingCall, setIncomingCall] = useState(null); // { callerId, roomId }
  const [activeCall, setActiveCall] = useState(null); // { roomId }
  const [callDuration, setCallDuration] = useState(0);
  const [callersOnline, setCallersOnline] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [remoteStream, setRemoteStream] = useState(null);
  const [remoteAudioLevel, setRemoteAudioLevel] = useState(0);
  const [showCallPanel, setShowCallPanel] = useState(false);

  // Refs
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const timerRef = useRef(null);
  const socketRef = useRef(null);
  const audioContextRef = useRef(null);

  // Initialize
  useEffect(() => {
    // Connect socket
    const sock = connectSocket('staff', staffToken);
    socketRef.current = sock;

    // Authenticate with backend
    staffConnect(staffId, staffToken);

    // Request WebRTC config
    requestWebrtcConfig();

    // Setup socket listeners
    sock.on('staff:connected', (data) => {
      console.log('Staff connected:', data);
    });

    sock.on('call:incoming', ({ callerId, roomId }) => {
      setIncomingCall({ callerId, roomId });
    });

    sock.on('call:connected', ({ roomId }) => {
      setActiveCall({ roomId });
      setShowCallPanel(true);
      startCallTimer();
    });

    sock.on('call:ended', () => {
      setIncomingCall(null);
      setActiveCall(null);
      setCallDuration(0);
      setShowCallPanel(false);
      cleanupCall();
    });

    sock.on('call:error', ({ message }) => {
      setIncomingCall(null);
      alert(message);
    });

    sock.on('staff:availability', (data) => {
      setCallersOnline(data.availableCount);
    });

    sock.on('webrtc:offer', async ({ roomId, sdp }) => {
      try {
        if (sdp) {
          await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
          const answer = await peerConnectionRef.current.createAnswer();
          await peerConnectionRef.current.setLocalDescription(answer);
          sendSdpAnswer(roomId, answer);
        } else {
          // Create and send offer
          const offer = await peerConnectionRef.current.createOffer();
          await peerConnectionRef.current.setLocalDescription(offer);
          sendSdpOffer(roomId, offer);
        }
      } catch (err) {
        console.error('WebRTC error:', err);
      }
    });

    sock.on('webrtc:sdp-offer', async ({ roomId, sdp }) => {
      try {
        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await peerConnectionRef.current.createAnswer();
        await peerConnectionRef.current.setLocalDescription(answer);
        sendSdpAnswer(roomId, answer);
      } catch (err) {
        console.error('SDP error:', err);
      }
    });

    sock.on('webrtc:sdp-answer', async ({ roomId, sdp }) => {
      try {
        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
      } catch (err) {
        console.error('SDP answer error:', err);
      }
    });

    sock.on('webrtc:ice-candidate', async ({ roomId, candidate }) => {
      try {
        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('ICE candidate error:', err);
      }
    });

    return () => {
      cleanupCall();
      sock.disconnect();
    };
  }, [staffToken, staffId]);

  // Start microphone for staff
  const startMicrophone = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStreamRef.current = stream;
      stream.getTracks().forEach((track) => {
        peerConnectionRef.current?.addTrack(track, stream);
      });
      return true;
    } catch (err) {
      console.error('Microphone access denied:', err);
      return false;
    }
  };

  // Setup remote audio visualization
  const setupRemoteVisualization = (stream) => {
    remoteStreamRef.current = stream;
    setRemoteStream(stream);

    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = audioContextRef.current;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);

      const interval = setInterval(() => {
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setRemoteAudioLevel(avg / 255);
      }, 50);
      window._whisperRemoteInterval = interval;
    } catch (err) {
      console.warn('Remote visualization failed:', err);
    }
  };

  // Accept call
  const handleAcceptCall = async () => {
    if (!incomingCall) return;

    const hasMic = await startMicrophone();
    if (!hasMic) {
      alert('Microphone access required');
      setIncomingCall(null);
      return;
    }

    // Create peer connection
    peerConnectionRef.current = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });

    peerConnectionRef.current.ontrack = (event) => {
      setupRemoteVisualization(event.streams[0]);
    };

    // Accept on backend
    staffAcceptCall(incomingCall.callerId, incomingCall.roomId);
    setIncomingCall(null);
  };

  // Decline call
  const handleDeclineCall = () => {
    if (incomingCall) {
      staffDeclineCall(incomingCall.callerId);
      setIncomingCall(null);
    }
  };

  // Mute/Unmute
  const handleToggleMute = () => {
    if (localStreamRef.current) {
      const enabled = !isMuted;
      localStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = enabled;
      });
      setIsMuted(!isMuted);
    }
  };

  // End call
  const handleEndCall = () => {
    getSocket()?.emit('call:end', { roomId: activeCall?.roomId });
    cleanupCall();
    setActiveCall(null);
    setCallDuration(0);
    setShowCallPanel(false);
  };

  // Call timer
  const startCallTimer = () => {
    setCallDuration(0);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCallDuration((prev) => prev + 1);
    }, 1000);
  };

  // Cleanup
  const cleanupCall = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (window._whisperRemoteInterval) clearInterval(window._whisperRemoteInterval);

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }

    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    setIsMuted(false);
    setRemoteAudioLevel(0);
    setRemoteStream(null);
  };

  // Toggle status
  const handleStatusToggle = () => {
    const newStatus = status === 'available' ? 'busy' : 'available';
    setStatus(newStatus);
    staffToggleStatus(newStatus);
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--dash-bg)',
    }}>
      {/* Header */}
      <header style={{
        background: 'var(--dash-header)',
        borderBottom: '1px solid var(--dash-border)',
        padding: '16px 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '36px',
            height: '36px',
            borderRadius: '10px',
            background: 'linear-gradient(135deg, var(--accent-blue), var(--accent-purple))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </div>
          <div>
            <h1 style={{ fontSize: '18px', fontWeight: 600 }}>WhisperWeb</h1>
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Staff Dashboard</p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {/* Status toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              {status === 'available' ? 'Available' : 'Busy'}
            </span>
            <button
              onClick={handleStatusToggle}
              style={{
                width: '48px',
                height: '26px',
                borderRadius: '13px',
                background: status === 'available' ? 'var(--accent-green)' : 'var(--bg-tertiary)',
                position: 'relative',
                transition: 'background 0.2s',
                border: 'none',
              }}
            >
              <div style={{
                width: '20px',
                height: '20px',
                borderRadius: '50%',
                background: 'white',
                position: 'absolute',
                top: '3px',
                left: status === 'available' ? '25px' : '3px',
                transition: 'left 0.2s',
              }} />
            </button>
          </div>

          {/* Online callers count */}
          <div style={{
            padding: '6px 12px',
            borderRadius: '20px',
            background: 'var(--bg-tertiary)',
            fontSize: '13px',
            color: 'var(--text-secondary)',
          }}>
            {callersOnline} agent{callersOnline !== 1 ? 's' : ''} online
          </div>

          {/* Logout */}
          <button
            onClick={logout}
            style={{
              padding: '8px 16px',
              borderRadius: '8px',
              background: 'var(--bg-tertiary)',
              color: 'var(--text-secondary)',
              fontSize: '13px',
              fontWeight: 500,
              transition: 'all 0.2s',
            }}
          >
            Sign Out
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main style={{ padding: '24px', maxWidth: '800px', margin: '0 auto' }}>
        {/* Status indicator */}
        <div style={{
          padding: '16px 20px',
          borderRadius: 'var(--radius)',
          background: status === 'available'
            ? 'rgba(34, 197, 94, 0.08)'
            : 'rgba(239, 68, 68, 0.08)',
          border: `1px solid ${status === 'available' ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`,
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          marginBottom: '24px',
        }}>
          <div style={{
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            background: status === 'available' ? 'var(--accent-green)' : 'var(--accent-red)',
          }} />
          <span style={{ fontSize: '15px', fontWeight: 500 }}>
            {status === 'available'
              ? 'Receiving calls — You are available for anonymous consultations'
              : 'Paused — You will not receive new calls'}
          </span>
        </div>

        {/* Incoming Call Modal */}
        {incomingCall && !activeCall && (
          <div style={{
            padding: '32px',
            borderRadius: 'var(--radius-lg)',
            background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.1), rgba(139, 92, 246, 0.1))',
            border: '1px solid rgba(59, 130, 246, 0.3)',
            textAlign: 'center',
            marginBottom: '24px',
            animation: 'slideDown 0.3s ease',
          }}>
            <div style={{
              width: '80px',
              height: '80px',
              borderRadius: '50%',
              background: 'var(--accent-blue)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 20px',
              boxShadow: '0 0 40px rgba(59, 130, 246, 0.4)',
              animation: 'pulse 1.5s ease-in-out infinite',
            }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="white">
                <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" opacity="0.3"/>
                <path d="M20 16.59A8 8 0 0 0 6.83 3.16L2 8l4 1 2-2 2 2-1 4 4.59-3.41"/>
              </svg>
            </div>

            <h3 style={{ fontSize: '22px', fontWeight: 600, marginBottom: '8px' }}>
              Incoming Call
            </h3>
            <p style={{ fontSize: '15px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
              Anonymous Caller
            </p>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '28px' }}>
              No caller details — anonymous consultation
            </p>

            <div style={{ display: 'flex', justifyContent: 'center', gap: '16px' }}>
              <button
                onClick={handleDeclineCall}
                style={{
                  padding: '12px 32px',
                  borderRadius: 'var(--radius)',
                  background: 'var(--accent-red)',
                  color: 'white',
                  fontSize: '15px',
                  fontWeight: 600,
                  transition: 'all 0.2s',
                }}
              >
                Decline
              </button>
              <button
                onClick={handleAcceptCall}
                style={{
                  padding: '12px 32px',
                  borderRadius: 'var(--radius)',
                  background: 'var(--accent-green)',
                  color: 'white',
                  fontSize: '15px',
                  fontWeight: 600,
                  transition: 'all 0.2s',
                  boxShadow: '0 4px 15px rgba(34, 197, 94, 0.3)',
                }}
              >
                Accept
              </button>
            </div>
          </div>
        )}

        {/* Active Call Panel */}
        {activeCall && (
          <div style={{
            padding: '24px',
            borderRadius: 'var(--radius-lg)',
            background: 'var(--dash-card)',
            border: '1px solid var(--dash-border)',
            marginBottom: '24px',
          }}>
            {/* Call header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
              <div>
                <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '4px' }}>
                  Active Call
                </h3>
                <p style={{ fontSize: '14px', color: 'var(--accent-green)' }}>
                  ● Anonymous Caller
                </p>
              </div>
              <div style={{
                fontSize: '24px',
                fontWeight: 600,
                fontFamily: 'monospace',
                color: 'var(--text-primary)',
              }}>
                {formatDuration(callDuration)}
              </div>
            </div>

            {/* Audio visualizer */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '3px',
              height: '40px',
              marginBottom: '20px',
            }}>
              {Array.from({ length: 30 }).map((_, i) => {
                const center = 15;
                const dist = Math.abs(i - center) / center;
                const base = Math.max(4, (1 - dist) * 30);
                const active = remoteAudioLevel > 0.05 ? base * (0.3 + remoteAudioLevel * 0.7) : base * 0.2;
                return (
                  <div
                    key={i}
                    style={{
                      width: '4px',
                      height: `${active}px`,
                      borderRadius: '2px',
                      background: `linear-gradient(to top, var(--accent-blue), var(--accent-purple))`,
                      transition: 'height 0.1s ease',
                      opacity: remoteAudioLevel > 0.05 ? 0.8 : 0.3,
                    }}
                  />
                );
              })}
            </div>

            {/* Controls */}
            <div style={{
              display: 'flex',
              justifyContent: 'center',
              gap: '20px',
            }}>
              {/* Mute button */}
              <button
                onClick={handleToggleMute}
                style={{
                  width: '56px',
                  height: '56px',
                  borderRadius: '50%',
                  background: isMuted ? 'var(--accent-red)' : 'var(--bg-tertiary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'all 0.2s',
                  border: 'none',
                }}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                  {isMuted && <line x1="1" y1="1" x2="23" y2="23" stroke="white" strokeWidth="2" />}
                </svg>
              </button>

              {/* End call button */}
              <button
                onClick={handleEndCall}
                style={{
                  width: '64px',
                  height: '64px',
                  borderRadius: '50%',
                  background: 'var(--accent-red)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 15px rgba(239, 68, 68, 0.3)',
                  transition: 'all 0.2s',
                  border: 'none',
                }}
              >
                <svg width="28" height="28" viewBox="0 0 24 24" fill="white">
                  <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.1-.7-.28a11.27 11.27 0 0 0-2.67-1.85.996.996 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/>
                </svg>
              </button>
            </div>

            <p style={{ textAlign: 'center', marginTop: '16px', fontSize: '13px', color: 'var(--text-secondary)' }}>
              {isMuted ? '🔇 You are muted' : '🎤 You are live'}
            </p>
          </div>
        )}

        {/* Instructions when idle */}
        {!incomingCall && !activeCall && (
          <div style={{
            padding: '40px',
            borderRadius: 'var(--radius-lg)',
            background: 'var(--dash-card)',
            border: '1px solid var(--dash-border)',
            textAlign: 'center',
          }}>
            <div style={{
              width: '64px',
              height: '64px',
              borderRadius: '50%',
              background: 'var(--bg-tertiary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 20px',
            }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2">
                <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" opacity="0.3"/>
                <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" opacity="0.5"/>
              </svg>
            </div>
            <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>
              {status === 'available'
                ? 'Waiting for incoming calls...'
                : 'You are currently away'}
            </h3>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)', maxWidth: '300px', margin: '0 auto', lineHeight: 1.6 }}>
              {status === 'available'
                ? 'Anonymous callers will be connected to you when they start a call.'
                : 'Toggle your status to start receiving calls.'}
            </p>
          </div>
        )}
      </main>

      <style>{`
        @keyframes slideDown {
          from { opacity: 0; transform: translateY(-20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.05); opacity: 0.9; }
        }
      `}</style>
    </div>
  );
}
