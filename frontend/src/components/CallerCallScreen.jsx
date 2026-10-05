import { useEffect, useState, useCallback, useRef } from 'react';
import { formatDuration } from '../hooks/useWebRTC';
import {
  getSocket,
  connectSocket,
  callerJoin,
  callerStartCall,
  callerEndCall,
  sendSdpOffer,
  sendSdpAnswer,
  sendIceCandidate,
  requestWebrtcConfig,
} from '../utils/socket';

// ============================================================
// CallerCallScreen — Messenger-style call interface
// Privacy: Completely anonymous. No PII transmitted or stored.
// A random UUID is generated on join and destroyed on call end.
// ============================================================

export default function CallerCallScreen() {
  const [status, setStatus] = useState('idle'); // idle | ringing | connecting | connected | ended | no-agents
  const [sessionId, setSessionId] = useState(null);
  const [roomId, setRoomId] = useState(null);
  const [message, setMessage] = useState('');
  const [remoteStream, setRemoteStream] = useState(null);
  const [localAudioLevel, setLocalAudioLevel] = useState(0);
  const [remoteAudioLevel, setRemoteAudioLevel] = useState(0);
  const [callDuration, setCallDuration] = useState(0);
  const [hasMicrophone, setHasMicrophone] = useState(false);

  // WebRTC
  const peerRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const timerRef = useRef(null);
  const socketRef = useRef(null);
  const audioContextRef = useRef(null);
  const sourceRef = useRef(null);
  const analyserRef = useRef(null);
  const levelIntervalRef = useRef(null);

  // Initialize
  useEffect(() => {
    // Generate ephemeral session ID — stored only in memory
    const session = crypto.randomUUID();
    setSessionId(session);

    // Connect to socket
    const sock = connectSocket('caller');
    socketRef.current = sock;

    // Join with anonymous session
    callerJoin();

    // Request WebRTC config
    requestWebrtcConfig();

    // Setup socket listeners
    sock.on('call:ringing', ({ roomId: rid }) => {
      setStatus('ringing');
      setMessage('Connecting you to support...');
      setRoomId(rid);
    });

    sock.on('call:connected', ({ roomId: rid, staffName }) => {
      setStatus('connected');
      setMessage('Connected to Anonymous Support');
      setRoomId(rid);
      startCallTimer();
    });

    sock.on('call:no-agents', ({ message: msg }) => {
      setStatus('no-agents');
      setMessage(msg || 'No agents available. Please try again.');
    });

    sock.on('call:ended', () => {
      setStatus('ended');
      setMessage('Call ended');
      cleanupCall();
    });

    sock.on('call:declined', () => {
      setStatus('no-agents');
      setMessage('No agent available. Please try again.');
    });

    sock.on('webrtc:offer', async ({ roomId: rid, sdp }) => {
      try {
        if (sdp) {
          await peerRef.current?.setRemoteDescription(new RTCSessionDescription(sdp));
          const answer = await peerRef.current.createAnswer();
          await peerRef.current.setLocalDescription(answer);
          sendSdpAnswer(rid, answer);
        } else if (sdp === undefined) {
          // Caller created offer, send it
          const offer = await peerRef.current.createOffer();
          await peerRef.current.setLocalDescription(offer);
          sendSdpOffer(rid, offer);
        }
      } catch (err) {
        console.error('WebRTC offer/answer error:', err);
      }
    });

    sock.on('webrtc:sdp-offer', async ({ roomId: rid, sdp }) => {
      try {
        await peerRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await peerRef.current.createAnswer();
        await peerRef.current.setLocalDescription(answer);
        sendSdpAnswer(rid, answer);
      } catch (err) {
        console.error('SDP offer error:', err);
      }
    });

    sock.on('webrtc:sdp-answer', async ({ roomId: rid, sdp }) => {
      try {
        await peerRef.current.setRemoteDescription(new RTCSessionDescription(sdp));
      } catch (err) {
        console.error('SDP answer error:', err);
      }
    });

    sock.on('webrtc:ice-candidate', async ({ roomId: rid, candidate }) => {
      try {
        await peerRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('ICE candidate error:', err);
      }
    });

    return () => {
      cleanupCall();
      sock.disconnect();
    };
  }, []);

  // Start call button
  const handleStartCall = async () => {
    const hasMic = await startMicrophone();
    if (!hasMic) {
      setMessage('Microphone access required to make a call');
      return;
    }
    callerStartCall();
  };

  // Start microphone
  const startMicrophone = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStreamRef.current = stream;
      setHasMicrophone(true);
      return true;
    } catch (err) {
      console.error('Microphone access denied:', err);
      return false;
    }
  };

  // Setup audio visualization
  const setupVisualization = useCallback(() => {
    try {
      if (localStreamRef.current) {
        audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = audioContextRef.current.createAnalyser();
        analyser.fftSize = 256;
        analyserRef.current = analyser;

        sourceRef.current = audioContextRef.current.createMediaStreamSource(localStreamRef.current);
        sourceRef.current.connect(analyser);

        if (levelIntervalRef.current) clearInterval(levelIntervalRef.current);
        levelIntervalRef.current = setInterval(() => {
          const data = new Uint8Array(analyser.frequencyBinCount);
          analyser.getByteFrequencyData(data);
          const avg = data.reduce((a, b) => a + b, 0) / data.length;
          setLocalAudioLevel(avg / 255);
        }, 50);
      }

      if (remoteStreamRef.current) {
        const ctx = audioContextRef.current;
        if (ctx) {
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          const source = ctx.createMediaStreamSource(remoteStreamRef.current);
          source.connect(analyser);

          const interval = setInterval(() => {
            const data = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(data);
            const avg = data.reduce((a, b) => a + b, 0) / data.length;
            setRemoteAudioLevel(avg / 255);
          }, 50);
          window._whisperRemoteInterval = interval;
        }
      }
    } catch (err) {
      console.warn('Visualization setup failed:', err);
    }
  }, []);

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
    if (levelIntervalRef.current) clearInterval(levelIntervalRef.current);
    if (window._whisperRemoteInterval) clearInterval(window._whisperRemoteInterval);

    if (sourceRef.current) sourceRef.current.disconnect();
    if (audioContextRef.current) audioContextRef.current.close();

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }

    if (peerRef.current) {
      peerRef.current.close();
      peerRef.current = null;
    }
  };

  // End call
  const handleEndCall = () => {
    if (roomId) {
      callerEndCall(roomId);
    }
    cleanupCall();
    setStatus('ended');
    setMessage('Call ended');
  };

  // Retry call
  const handleRetry = () => {
    setStatus('idle');
    setMessage('');
    setRoomId(null);
    setCallDuration(0);
    setLocalAudioLevel(0);
    setRemoteAudioLevel(0);
  };

  // Waveform visualization
  const WaveformVisualizer = ({ active, level }) => {
    const bars = 20;
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '3px',
        height: '60px',
        marginTop: '40px',
      }}>
        {Array.from({ length: bars }).map((_, i) => {
          const center = bars / 2;
          const distance = Math.abs(i - center) / center;
          const baseHeight = Math.max(4, (1 - distance) * 50);
          const activeHeight = level > 0
            ? baseHeight * (0.3 + level * 0.7 + Math.sin(Date.now() / 200 + i) * 0.3)
            : baseHeight * 0.2;

          return (
            <div
              key={i}
              style={{
                width: '4px',
                height: `${active ? activeHeight : baseHeight * 0.3}px`,
                borderRadius: '2px',
                background: active
                  ? `linear-gradient(to top, var(--accent-blue), var(--accent-purple))`
                  : 'var(--bg-tertiary)',
                transition: 'height 0.15s ease',
                opacity: active ? 1 : 0.4,
              }}
            />
          );
        })}
      </div>
    );
  };

  // Animated rings for ringing state
  const AnimatedRings = ({ count, level }) => (
    <div style={{
      position: 'relative',
      width: '200px',
      height: '200px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      {[0, 1, 2].map((ring) => (
        <div
          key={ring}
          style={{
            position: 'absolute',
            width: `${160 + ring * 40}px`,
            height: `${160 + ring * 40}px`,
            borderRadius: '50%',
            border: `2px solid var(--accent-blue)`,
            opacity: status === 'ringing' ? 0.6 - ring * 0.2 : 0.1,
            animation: status === 'ringing' ? `pulse-ring ${2 + ring * 0.5}s ease-in-out infinite` : 'none',
            transform: `scale(${1 + (level || 0) * 0.05})`,
            transition: 'transform 0.1s ease',
          }}
        />
      ))}
      <div style={{
        width: '120px',
        height: '120px',
        borderRadius: '50%',
        background: 'radial-gradient(circle, var(--accent-blue) 0%, var(--accent-purple) 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transform: `scale(${1 + (level || 0) * 0.1})`,
        transition: 'transform 0.1s ease',
        boxShadow: `0 0 ${40 + level * 40}px rgba(59, 130, 246, ${0.3 + level * 0.4})`,
      }}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
      </div>
    </div>
  );

  const renderContent = () => {
    switch (status) {
      case 'idle':
        return (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '12px', letterSpacing: '1px', textTransform: 'uppercase' }}>
              Anonymous Support
            </div>
            <AnimatedRings count={1} level={0} />
            <h2 style={{ fontSize: '28px', fontWeight: 600, marginTop: '40px', marginBottom: '8px' }}>
              Need to talk?
            </h2>
            <p style={{ fontSize: '16px', color: 'var(--text-secondary)', marginBottom: '50px', maxWidth: '320px', lineHeight: 1.6 }}>
              Anonymous voice consultation. No identity stored. No recordings.
            </p>
            <button
              onClick={handleStartCall}
              style={{
                width: '72px',
                height: '72px',
                borderRadius: '50%',
                background: 'var(--accent-green)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 4px 20px rgba(34, 197, 94, 0.4)',
                transition: 'all 0.2s ease',
              }}
              onMouseEnter={(e) => {
                e.target.style.transform = 'scale(1.1)';
                e.target.style.boxShadow = '0 6px 25px rgba(34, 197, 94, 0.5)';
              }}
              onMouseLeave={(e) => {
                e.target.style.transform = 'scale(1)';
                e.target.style.boxShadow = '0 4px 20px rgba(34, 197, 94, 0.4)';
              }}
            >
              <svg width="32" height="32" viewBox="0 0 24 24" fill="white">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
              </svg>
            </button>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginTop: '20px' }}>
              Tap to start a call
            </p>
          </div>
        );

      case 'no-agents':
        return (
          <div style={{ textAlign: 'center' }}>
            <div style={{
              width: '100px',
              height: '100px',
              borderRadius: '50%',
              background: 'var(--bg-tertiary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 30px',
            }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
            <h2 style={{ fontSize: '24px', fontWeight: 600, marginBottom: '12px' }}>
              No Agents Available
            </h2>
            <p style={{ fontSize: '16px', color: 'var(--text-secondary)', marginBottom: '40px', lineHeight: 1.6 }}>
              {message}
            </p>
            <button
              onClick={handleRetry}
              style={{
                padding: '14px 40px',
                borderRadius: '28px',
                background: 'var(--accent-blue)',
                color: 'white',
                fontSize: '16px',
                fontWeight: 500,
                transition: 'all 0.2s ease',
              }}
              onMouseEnter={(e) => e.target.style.background = 'var(--accent-blue-hover)'}
              onMouseLeave={(e) => e.target.style.background = 'var(--accent-blue)'}
            >
              Try Again
            </button>
          </div>
        );

      case 'ringing':
      case 'connecting':
        return (
          <div style={{ textAlign: 'center' }}>
            <AnimatedRings count={1} level={localAudioLevel} />
            <h2 style={{ fontSize: '24px', fontWeight: 600, marginTop: '40px', marginBottom: '8px' }}>
              {status === 'ringing' ? 'Connecting...' : 'Connecting...'}
            </h2>
            <p style={{ fontSize: '16px', color: 'var(--text-secondary)' }}>
              {message}
            </p>
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
                marginTop: '50px',
                transition: 'all 0.2s ease',
              }}
              onMouseEnter={(e) => e.target.style.transform = 'scale(1.1)'}
              onMouseLeave={(e) => e.target.style.transform = 'scale(1)'}
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="white">
                <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.1-.7-.28a11.27 11.27 0 0 0-2.67-1.85.996.996 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/>
              </svg>
            </button>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginTop: '16px' }}>
              End Call
            </p>
          </div>
        );

      case 'connected':
        return (
          <div style={{ textAlign: 'center' }}>
            <div style={{
              width: '140px',
              height: '140px',
              borderRadius: '50%',
              background: 'radial-gradient(circle, var(--accent-blue) 0%, var(--accent-purple) 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto',
              boxShadow: `0 0 ${60 + remoteAudioLevel * 30}px rgba(59, 130, 246, ${0.3 + remoteAudioLevel * 0.3})`,
              transform: `scale(${1 + remoteAudioLevel * 0.08})`,
              transition: 'transform 0.1s ease',
            }}>
              <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" opacity="0.3"/>
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                <line x1="12" y1="19" x2="12" y2="23"/>
                <line x1="8" y1="23" x2="16" y2="23"/>
              </svg>
            </div>
            <h2 style={{ fontSize: '24px', fontWeight: 600, marginTop: '30px', marginBottom: '4px' }}>
              Anonymous Support
            </h2>
            <p style={{ fontSize: '14px', color: 'var(--accent-green)', marginBottom: '8px' }}>
              ● Connected
            </p>
            <p style={{ fontSize: '18px', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '10px' }}>
              {formatDuration(callDuration)}
            </p>

            <WaveformVisualizer active={true} level={remoteAudioLevel} />

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '40px', marginTop: '40px' }}>
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
                  transition: 'all 0.2s ease',
                }}
                onMouseEnter={(e) => e.target.style.transform = 'scale(1.1)'}
                onMouseLeave={(e) => e.target.style.transform = 'scale(1)'}
              >
                <svg width="28" height="28" viewBox="0 0 24 24" fill="white">
                  <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.1-.7-.28a11.27 11.27 0 0 0-2.67-1.85.996.996 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/>
                </svg>
              </button>
            </div>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginTop: '16px' }}>
              End Call
            </p>
          </div>
        );

      case 'ended':
        return (
          <div style={{ textAlign: 'center' }}>
            <div style={{
              width: '100px',
              height: '100px',
              borderRadius: '50%',
              background: 'var(--bg-tertiary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 30px',
            }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
            <h2 style={{ fontSize: '24px', fontWeight: 600, marginBottom: '8px' }}>
              Call Ended
            </h2>
            {callDuration > 0 && (
              <p style={{ fontSize: '16px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                Duration: {formatDuration(callDuration)}
              </p>
            )}
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '40px' }}>
              No call data is stored or recorded
            </p>
            <button
              onClick={handleRetry}
              style={{
                padding: '14px 40px',
                borderRadius: '28px',
                background: 'var(--accent-blue)',
                color: 'white',
                fontSize: '16px',
                fontWeight: 500,
                transition: 'all 0.2s ease',
              }}
              onMouseEnter={(e) => e.target.style.background = 'var(--accent-blue-hover)'}
              onMouseLeave={(e) => e.target.style.background = 'var(--accent-blue)'}
            >
              Start New Call
            </button>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, var(--bg-primary) 0%, #0a0f1e 100%)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Subtle background gradient */}
      <div style={{
        position: 'absolute',
        top: '-50%',
        left: '-50%',
        width: '200%',
        height: '200%',
        background: 'radial-gradient(ellipse at 50% 50%, rgba(59, 130, 246, 0.03) 0%, transparent 70%)',
        pointerEvents: 'none',
      }} />

      {/* Brand */}
      <div style={{
        position: 'absolute',
        top: '30px',
        left: '30px',
        fontSize: '14px',
        color: 'var(--text-secondary)',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>
        WhisperWeb
      </div>

      {renderContent()}

      {/* Keyframe animations */}
      <style>{`
        @keyframes pulse-ring {
          0%, 100% { opacity: 0.3; transform: scale(0.95); }
          50% { opacity: 0.7; transform: scale(1.05); }
        }
      `}</style>
    </div>
  );
}
