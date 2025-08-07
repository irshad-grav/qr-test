// src/components/CodeScanner.tsx
import React, { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import type { IScannerControls } from '@zxing/browser';

type CameraDevice = {
  deviceId: string;
  label: string;
};

type CodeScannerProps = {
  onResult?: (text: string, raw: unknown) => void;
  onError?: (err: unknown) => void;
  className?: string;
};

const CodeScanner: React.FC<CodeScannerProps> = ({
  onResult,
  onError,
  className = '',
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [isStarting, setIsStarting] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const controlsRef = useRef<IScannerControls | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);

  // Enumerate cameras and pre-request permission for labels
  useEffect(() => {
    const initDevices = async () => {
      try {
        await navigator.mediaDevices.getUserMedia({ video: true });
      } catch {
        // Ignore; labels may be blank if permission denied
      }

      try {
        const allDevices = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = allDevices
          .filter((d) => d.kind === 'videoinput')
          .map((d, idx) => ({
            deviceId: d.deviceId,
            label: d.label || `Camera ${idx + 1}`,
          }));

        setDevices(videoInputs);

        // Prefer a "back" camera if present
        const preferredId =
          videoInputs.find((d) => d.label.toLowerCase().includes('back'))
            ?.deviceId || videoInputs[0]?.deviceId;

        if (preferredId) setSelectedDeviceId(preferredId);
      } catch (err) {
        onError?.(err);
      }
    };

    initDevices();
  }, [onError]);

  const detectTorchSupport = async () => {
    try {
      const stream = videoRef.current?.srcObject as MediaStream | null;
      const track = stream?.getVideoTracks()[0];
      if (!track) {
        setTorchSupported(false);
        return;
      }

      // Check via MediaTrackCapabilities
      const capabilities = track.getCapabilities
        ? (track.getCapabilities() as any)
        : null;

      // Some browsers expose "torch" in capabilities. If not, try ImageCapture.
      let supported = !!capabilities?.torch;

      if (!supported && 'ImageCapture' in window) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const imageCapture = new (window as any).ImageCapture(track);
        try {
          const photoCaps = await imageCapture.getPhotoCapabilities();
          // If device supports fillLightMode including "flash", torch usually works
          supported = Array.isArray(photoCaps.fillLightMode)
            ? photoCaps.fillLightMode.includes('flash') ||
              photoCaps.fillLightMode.includes('torch')
            : false;
        } catch {
          // Ignore; not supported
        }
      }

      setTorchSupported(!!supported);
    } catch {
      setTorchSupported(false);
    }
  };

  // Start scanning with the selected device
  const start = async (deviceId?: string) => {
    if (!videoRef.current) return;
    if (isStarting || isRunning) return;

    try {
      setIsStarting(true);

      // Stop previous
      controlsRef.current?.stop();
      controlsRef.current = null;

      if (!readerRef.current) {
        readerRef.current = new BrowserMultiFormatReader();
      }

      const controls = await readerRef.current.decodeFromVideoDevice(
        deviceId ?? selectedDeviceId,
        videoRef.current,
        (result, err) => {
          if (result) {
            onResult?.(result.getText(), result);
            // Optional haptic
            if (navigator.vibrate) navigator.vibrate(60);
          } else if (err) {
            // Ignore frequent NotFoundException between frames
          }
        }
      );

      if (controls) {
        controlsRef.current = controls;
        setIsRunning(true);
        // After stream is live, detect torch capability
        // Give the video a brief moment to attach stream
        setTimeout(() => {
          detectTorchSupport();
        }, 150);
      }
    } catch (err) {
      onError?.(err);
      setIsRunning(false);
    } finally {
      setIsStarting(false);
    }
  };

  const stop = () => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    setIsRunning(false);
    setTorchOn(false);
    setTorchSupported(false);
  };

  // Restart when camera changes
  useEffect(() => {
    if (!selectedDeviceId) return;
    start(selectedDeviceId);
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDeviceId]);

  // Toggle torch if supported
  const toggleTorch = async () => {
    try {
      const stream = videoRef.current?.srcObject as MediaStream | null;
      const track = stream?.getVideoTracks()[0];
      if (!track) return;

      // Apply constraints with "torch" advanced setting
      await track.applyConstraints({
        advanced: [{ torch: !torchOn }],
      } as unknown as MediaTrackConstraints);

      setTorchOn((v) => !v);
    } catch {
      // Some browsers require ImageCapture trick; fallback attempt:
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const imageCapture = new (window as any).ImageCapture(
          (videoRef.current?.srcObject as MediaStream).getVideoTracks()[0]
        );
        const next = !torchOn;
        await imageCapture.setOptions?.({
          fillLightMode: next ? 'flash' : 'off',
        });
        setTorchOn(next);
      } catch {
        // Torch not supported or user denied
      }
    }
  };

  const handleDeviceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedDeviceId(e.target.value);
  };

  return (
    <div
      className={[
        'w-full max-w-md mx-auto space-y-3',
        'bg-white rounded-xl shadow p-4',
        className,
      ].join(' ')}
    >
      <div className='flex items-center gap-2'>
        <label className='text-sm font-medium text-gray-700'>
          Camera source
        </label>
        <select
          className='flex-1 rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500'
          value={selectedDeviceId}
          onChange={handleDeviceChange}
          disabled={devices.length === 0 || isStarting}
        >
          {devices.length === 0 && <option>No camera found</option>}
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      <div className='relative aspect-[3/4] w-full overflow-hidden rounded-lg bg-black'>
        <video
          ref={videoRef}
          className='h-full w-full object-cover'
          muted
          playsInline
        />
        <div className='pointer-events-none absolute inset-0 flex items-center justify-center'>
          <div className='h-44 w-44 rounded-md border-2 border-white/80' />
        </div>
      </div>

      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex items-center gap-2'>
          <button
            className='rounded bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700 disabled:opacity-50'
            onClick={() => start()}
            disabled={isStarting || isRunning || !selectedDeviceId}
          >
            {isStarting ? 'Starting...' : 'Start'}
          </button>
          <button
            className='rounded bg-gray-200 px-4 py-2 hover:bg-gray-300 disabled:opacity-50'
            onClick={stop}
            disabled={!isRunning}
          >
            Stop
          </button>
        </div>

        <button
          className='rounded bg-amber-500 px-3 py-2 text-white hover:bg-amber-600 disabled:opacity-50'
          onClick={toggleTorch}
          disabled={!isRunning || !torchSupported}
          title={
            !isRunning
              ? 'Start camera to use torch'
              : !torchSupported
              ? 'Torch not supported on this device'
              : 'Toggle torch'
          }
        >
          {torchOn ? 'Torch Off' : 'Torch On'}
        </button>
      </div>
    </div>
  );
};

export default CodeScanner;
