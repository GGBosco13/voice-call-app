import { useState, useEffect, useRef, useCallback } from 'react';

// ============================================================
// WHISPERWEB — WebRTC peer connection helper
//
// Privacy: No caller identity is ever stored or transmitted.
// Only SDP and ICE candidates are relayed through the signaling
// server. No audio is recorded or streamed to the backend.
// ============================================================

const DEFAULT_STUN = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export function useWebRTC(role, onRemoteStream, onCallEnd) {
  const peerConnection = useRef(null);
  const localStream = useRef(null);
  const remoteStream = useRef(null);
  const [isLocalMuted, setIsLocalMuted] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [localAudioLevel, setLocalAudioLevel] = useState(0);
  const [remoteAudioLevel, setRemoteAudioLevel] = useState(0);

  const timerRef = useRef(null);
  const analyserRef = useRef(null);
  const audioContextRef = useRef(null);
  const sourceRef = useRef(null);

  // Initialize WebRTC
  useEffect(() => {
    const config = {
      iceServers: DEFAULT_STUN,
    };

    peerConnection.current = new RTCPeerConnection(config);

    peerConnection.current.ontrack = (event) => {
      remoteStream.current = event.streams[0];
      onRemoteStream(event.streams[0]);
    };

    peerConnection.current.oniceconnectionstatechange = () => {
      if (peerConnection.current.iceConnectionState === 'disconnected' ||
          peerConnection.current.iceConnectionState === 'failed') {
        onCallEnd?.();
      }
    };

    // Cleanup on unmount
    return () => {
      cleanup();
    };
  }, []);

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    analyserRef.current = null;

    if (localStream.current) {
      localStream.current.getTracks().forEach((track) => track.stop());
      localStream.current = null;
    }

    if (peerConnection.current) {
      peerConnection.current.close();
      peerConnection.current = null;
    }

    setCallDuration(0);
    setIsLocalMuted(false);
    setLocalAudioLevel(0);
    setRemoteAudioLevel(0);
  }, []);

  // Start microphone
  const startMicrophone = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStream.current = stream;

      // Add local audio tracks
      stream.getTracks().forEach((track) => {
        peerConnection.current?.addTrack(track, stream);
      });

      // Setup audio visualization
      setupAudioVisualization(stream);

      return true;
    } catch (err) {
      console.error('Microphone access denied:', err);
      return false;
    }
  };

  // Setup audio level visualization
  const setupAudioVisualization = (stream) => {
    try {
      audioContextRef.current = new AudioContext();
      const analyser = audioContextRef.current.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;

      sourceRef.current = audioContextRef.current.createMediaStreamSource(stream);
      sourceRef.current.connect(analyser);

      // Update audio level periodically
      const updateLevel = () => {
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        setLocalAudioLevel(avg / 255); // Normalize to 0-1
      };

      const interval = setInterval(updateLevel, 50);
      // Store interval for cleanup
      window._whisperAudioInterval = interval;
    } catch (err) {
      console.warn('Audio visualization setup failed:', err);
    }
  };

  const setupRemoteVisualization = (stream) => {
    try {
      if (audioContextRef.current) {
        const analyser = audioContextRef.current.createAnalyser();
        analyser.fftSize = 256;
        const source = audioContextRef.current.createMediaStreamSource(stream);
        source.connect(analyser);

        const updateLevel = () => {
          const dataArray = new Uint8Array(analyser.frequencyBinCount);
          analyser.getByteFrequencyData(dataArray);
          const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
          setRemoteAudioLevel(avg / 255);
        };

        const interval = setInterval(updateLevel, 50);
        window._whisperRemoteInterval = interval;
      }
    } catch (err) {
      console.warn('Remote audio visualization failed:', err);
    }
  };

  // Create offer (Caller side)
  const createOffer = async () => {
    if (!localStream.current) return null;

    const offer = await peerConnection.current.createOffer();
    await peerConnection.current.setLocalDescription(offer);
    return offer;
  };

  // Set remote offer and create answer (Staff side)
  const setRemoteOffer = async (sdp) => {
    await peerConnection.current.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await peerConnection.current.createAnswer();
    await peerConnection.current.setLocalDescription(answer);
    return answer;
  };

  // Set remote answer (Caller side)
  const setRemoteAnswer = async (sdp) => {
    await peerConnection.current.setRemoteDescription(new RTCSessionDescription(sdp));
  };

  // Add ICE candidate
  const addIceCandidate = async (candidate) => {
    await peerConnection.current.addIceCandidate(new RTCIceCandidate(candidate));
  };

  // Toggle mute
  const toggleMute = () => {
    if (localStream.current) {
      const enabled = !isLocalMuted;
      localStream.current.getAudioTracks().forEach((track) => {
        track.enabled = enabled;
      });
      setIsLocalMuted(!enabled);
    }
  };

  // End call
  const endCall = () => {
    cleanup();
    onCallEnd?.();
  };

  // Call duration timer
  const startTimer = () => {
    setCallDuration(0);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCallDuration((prev) => prev + 1);
    }, 1000);
  };

  return {
    peerConnection: peerConnection.current,
    localStream: localStream.current,
    remoteStream: remoteStream.current,
    setupRemoteVisualization,
    isLocalMuted,
    callDuration,
    localAudioLevel,
    remoteAudioLevel,
    startMicrophone,
    createOffer,
    setRemoteOffer,
    setRemoteAnswer,
    addIceCandidate,
    toggleMute,
    endCall,
    startTimer,
  };
}

// Format call duration as HH:MM:SS
export function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}
