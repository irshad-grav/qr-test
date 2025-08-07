import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  type FC,
} from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import type { IScannerControls } from '@zxing/browser';

type CameraDevice = {
  deviceId: string;
  label: string;
};

type CodeScannerProps = {
  onResult?: (text: string, raw: unknown) => void;
  onError?: (err: Error) => void;
  className?: string;
};

const CodeScanner: FC<CodeScannerProps> = ({
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
  const mountedRef = useRef(true);

  // Helper to fully stop any active stream
  const stopActiveStream = (videoEl: HTMLVideoElement | null) => {
    const stream = (videoEl?.srcObject as MediaStream | null) ?? null;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      if (videoEl) {
        videoEl.srcObject = null;
      }
    }
  };

  // Initialize camera reader once
  useEffect(() => {
    readerRef.current = new BrowserMultiFormatReader();

    return () => {
      mountedRef.current = false;
      try {
        controlsRef.current?.stop();
      } finally {
        stopActiveStream(videoRef.current);
      }
    };
  }, []);

  // Handle errors consistently
  const handleError = useCallback(
    (err: unknown) => {
      if (!mountedRef.current) return;

      const error = err instanceof Error ? err : new Error(String(err));
      console.error('CodeScanner error:', error);
      onError?.(error);
    },
    [onError]
  );

  // Enumerate cameras with proper error handling
  const initDevices = useCallback(async () => {
    try {
      // Request permission first to get device labels
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
        });
        stream.getTracks().forEach((track) => track.stop());
      } catch {
        // Permission denied or no camera - continue anyway
      }

      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = allDevices
        .filter((d) => d.kind === 'videoinput')
        .map((d, idx) => ({
          deviceId: d.deviceId,
          label: d.label || `Camera ${idx + 1}`,
        }));

      if (!mountedRef.current) return;

      setDevices(videoInputs);

      if (videoInputs.length > 0) {
        // Prefer back camera, otherwise use first available
        const backCamera = videoInputs.find((d) =>
          /back|rear|environment/i.test(d.label)
        );
        const preferredId = backCamera?.deviceId || videoInputs[0].deviceId;
        setSelectedDeviceId(preferredId);
      }
    } catch (err) {
      handleError(err);
    }
  }, [handleError]);

  useEffect(() => {
    initDevices();
  }, [initDevices]);

  // Detect torch support with better error handling
  const detectTorchSupport = useCallback(async () => {
    try {
      const stream = videoRef.current?.srcObject as MediaStream | null;
      const track = stream?.getVideoTracks()[0];

      if (!track || !mountedRef.current) {
        setTorchSupported(false);
        return;
      }

      let supported = false;

      // Method 1: Check MediaTrackCapabilities
      if (track.getCapabilities) {
        const capabilities = track.getCapabilities() as any;
        supported = Boolean(capabilities?.torch);
      }

      // Method 2: ImageCapture API fallback
      if (!supported && 'ImageCapture' in window) {
        try {
          const imageCapture = new (window as any).ImageCapture(track);
          const photoCaps = await imageCapture.getPhotoCapabilities();
          supported =
            Array.isArray(photoCaps?.fillLightMode) &&
            (photoCaps.fillLightMode.includes('flash') ||
              photoCaps.fillLightMode.includes('torch'));
        } catch {
          // ImageCapture not supported or failed
        }
      }

      if (mountedRef.current) {
        setTorchSupported(supported);
      }
    } catch {
      if (mountedRef.current) {
        setTorchSupported(false);
      }
    }
  }, []);

  // Start scanning with better error handling and cleanup
  const start = useCallback(
    async (deviceId?: string) => {
      if (!videoRef.current || !readerRef.current) return;
      if (isStarting || isRunning) return;

      const targetDeviceId = deviceId ?? selectedDeviceId;
      if (!targetDeviceId) {
        handleError(new Error('No camera device selected'));
        return;
      }

      try {
        setIsStarting(true);
        setTorchOn(false);
        setTorchSupported(false);

        // Stop previous scanning and any active stream
        controlsRef.current?.stop();
        controlsRef.current = null;
        stopActiveStream(videoRef.current);

        const controls = await readerRef.current.decodeFromVideoDevice(
          targetDeviceId,
          videoRef.current,
          (result, err) => {
            if (!mountedRef.current) return;

            if (result) {
              onResult?.(result.getText(), result);
              // Optional haptic feedback
              if (
                'vibrate' in navigator &&
                typeof navigator.vibrate === 'function'
              ) {
                navigator.vibrate(60);
              }
            } else if (err && err.name !== 'NotFoundException') {
              // Only log non-routine errors (NotFoundException is expected between scans)
              console.debug('Scan error:', err.message);
            }
          }
        );

        if (!mountedRef.current) {
          controls?.stop();
          stopActiveStream(videoRef.current);
          return;
        }

        if (controls) {
          controlsRef.current = controls;

          // Force-attach stream and play (some browsers need this)
          const tryPlay = async () => {
            const video = videoRef.current!;
            const stream = video.srcObject as MediaStream | null;

            if (stream) {
              video.srcObject = stream;
            }

            // Wait for metadata to ensure dimensions are known
            await new Promise<void>((resolve) => {
              if (video.readyState >= 1) {
                resolve();
              } else {
                const onLoaded = () => {
                  video.removeEventListener('loadedmetadata', onLoaded);
                  resolve();
                };
                video.addEventListener('loadedmetadata', onLoaded, {
                  once: true,
                });
              }
            });

            try {
              await video.play();
            } catch (e) {
              // Autoplay might require a user gesture on some platforms.
              console.debug(
                'video.play() blocked, will require user gesture',
                e
              );
            }
          };

          try {
            await tryPlay();
          } catch (e) {
            console.debug('Video play attempt failed:', e);
          }

          setIsRunning(true);

          // Detect torch capability after stream is established
          setTimeout(() => {
            if (mountedRef.current) {
              detectTorchSupport();
            }
          }, 200);
        } else {
          throw new Error('Failed to start scanner controls');
        }
      } catch (err: any) {
        // Optional fallback: retry with facingMode when deviceId fails
        if (
          err?.name === 'OverconstrainedError' ||
          err?.name === 'NotFoundError'
        ) {
          try {
            const controls = await readerRef.current.decodeFromConstraints(
              {
                audio: false,
                video: { facingMode: { ideal: 'environment' } },
              },
              videoRef.current!,
              (result, e) => {
                if (result) {
                  onResult?.(result.getText(), result);
                } else if (e && e.name !== 'NotFoundException') {
                  console.debug('Scan error:', e.message);
                }
              }
            );

            if (!mountedRef.current) {
              controls?.stop();
              stopActiveStream(videoRef.current);
              return;
            }

            controlsRef.current = controls;

            try {
              await videoRef.current!.play();
            } catch {
              /* ignore */
            }

            setIsRunning(true);
            setTimeout(() => {
              if (mountedRef.current) detectTorchSupport();
            }, 200);
            return;
          } catch (e2) {
            // fall through to handleError below
            handleError(e2);
          }
        } else {
          handleError(err);
        }

        if (mountedRef.current) {
          setIsRunning(false);
        }
      } finally {
        if (mountedRef.current) {
          setIsStarting(false);
        }
      }
    },
    [
      isStarting,
      isRunning,
      selectedDeviceId,
      onResult,
      handleError,
      detectTorchSupport,
    ]
  );

  // Stop scanning with proper cleanup
  const stop = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    stopActiveStream(videoRef.current);
    setIsRunning(false);
    setTorchOn(false);
    setTorchSupported(false);
  }, []);

  // Auto-start when device changes
  useEffect(() => {
    if (!selectedDeviceId || !mountedRef.current) return;

    start(selectedDeviceId);

    return () => {
      stop();
    };
  }, [selectedDeviceId, start, stop]);

  // Toggle torch with multiple fallback methods
  const toggleTorch = useCallback(async () => {
    if (!isRunning || !torchSupported) return;

    try {
      const stream = videoRef.current?.srcObject as MediaStream | null;
      const track = stream?.getVideoTracks()[0];

      if (!track) return;

      const newTorchState = !torchOn;

      // Method 1: MediaTrackConstraints
      try {
        await track.applyConstraints({
          advanced: [{ torch: newTorchState } as any],
        });

        if (mountedRef.current) {
          setTorchOn(newTorchState);
        }
        return;
      } catch (constraintsError) {
        console.debug('Constraints method failed:', constraintsError);
      }

      // Method 2: ImageCapture API fallback
      if ('ImageCapture' in window) {
        try {
          const imageCapture = new (window as any).ImageCapture(track);
          if (imageCapture.setOptions) {
            await imageCapture.setOptions({
              fillLightMode: newTorchState ? 'flash' : 'off',
            });

            if (mountedRef.current) {
              setTorchOn(newTorchState);
            }
            return;
          }
        } catch (imageCaptureError) {
          console.debug('ImageCapture method failed:', imageCaptureError);
        }
      }

      throw new Error('Torch control not supported');
    } catch (err) {
      handleError(err);
    }
  }, [isRunning, torchSupported, torchOn, handleError]);

  const handleDeviceChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setSelectedDeviceId(e.target.value);
    },
    []
  );

  return (
    <div
      className={`w-full max-w-md mx-auto space-y-3 bg-white rounded-xl shadow p-4 ${className}`}
    >
      {/* Camera Selection */}
      <div className='flex items-center gap-2'>
        <label className='text-sm font-medium text-gray-700'>
          Camera source
        </label>
        <select
          className='flex-1 rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-100 disabled:cursor-not-allowed'
          value={selectedDeviceId}
          onChange={handleDeviceChange}
          disabled={devices.length === 0 || isStarting}
        >
          {devices.length === 0 ? (
            <option>No camera found</option>
          ) : (
            devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))
          )}
        </select>
      </div>

      {/* Video Preview */}
      <div className='relative aspect-[3/4] w-full overflow-hidden rounded-lg bg-black'>
        <video
          ref={videoRef}
          className='h-full w-full object-cover'
          muted
          playsInline
          autoPlay
        />
        {/* Scanning overlay */}
        <div className='pointer-events-none absolute inset-0 flex items-center justify-center'>
          <div className='h-44 w-44 rounded-md border-2 border-white/80 shadow-lg' />
        </div>

        {/* Status indicator */}
        {isRunning && (
          <div className='absolute top-2 right-2 bg-green-500 text-white px-2 py-1 rounded text-xs font-medium'>
            Scanning...
          </div>
        )}
      </div>

      {/* Controls */}
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex items-center gap-2'>
          <button
            className='rounded bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
            onClick={() => start()}
            disabled={isStarting || isRunning || !selectedDeviceId}
          >
            {isStarting ? 'Starting...' : 'Start'}
          </button>
          <button
            className='rounded bg-gray-500 px-4 py-2 text-white hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
            onClick={stop}
            disabled={!isRunning}
          >
            Stop
          </button>
        </div>

        <button
          className='rounded bg-amber-500 px-3 py-2 text-white hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
          onClick={toggleTorch}
          disabled={!isRunning || !torchSupported}
          title={
            !isRunning
              ? 'Start camera to use torch'
              : !torchSupported
              ? 'Torch not supported on this device'
              : torchOn
              ? 'Turn torch off'
              : 'Turn torch on'
          }
          aria-label={torchOn ? 'Turn torch off' : 'Turn torch on'}
        >
          {torchOn ? '🔦 Off' : '🔦 On'}
        </button>
      </div>
    </div>
  );
};

export default CodeScanner;
