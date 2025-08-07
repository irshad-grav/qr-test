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
  const [permissionStatus, setPermissionStatus] = useState<
    'granted' | 'denied' | 'prompt' | 'unknown'
  >('unknown');

  const controlsRef = useRef<IScannerControls | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const mountedRef = useRef(true);

  // Decode control flags
  const pausedRef = useRef(false);
  const lastResultAtRef = useRef(0);

  const stopActiveStream = (videoEl: HTMLVideoElement | null) => {
    const stream = (videoEl?.srcObject as MediaStream | null) ?? null;
    if (stream) {
      stream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          /* ignore */
        }
      });
      if (videoEl) videoEl.srcObject = null;
    }
  };

  useEffect(() => {
    readerRef.current = new BrowserMultiFormatReader();

    const onVis = () => {
      pausedRef.current = document.hidden;
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      mountedRef.current = false;
      document.removeEventListener('visibilitychange', onVis);
      try {
        controlsRef.current?.stop();
      } finally {
        stopActiveStream(videoRef.current);
      }
    };
  }, []);

  const handleError = useCallback(
    (err: unknown) => {
      if (!mountedRef.current) return;
      const e = err instanceof Error ? err : new Error(String(err));
      console.error('CodeScanner error:', e);
      console.error('Error details:', {
        name: e.name,
        message: e.message,
        stack: e.stack,
        permissionStatus,
        devices: devices.length,
        selectedDeviceId,
        isStarting,
        isRunning,
      });
      onError?.(e);
    },
    [
      onError,
      permissionStatus,
      devices.length,
      selectedDeviceId,
      isStarting,
      isRunning,
    ]
  );

  const checkPermissions = useCallback(async () => {
    try {
      // Check if we can query permissions
      if (navigator.permissions && navigator.permissions.query) {
        const permission = await navigator.permissions.query({
          name: 'camera' as PermissionName,
        });
        setPermissionStatus(permission.state);

        // Listen for permission changes
        permission.addEventListener('change', () => {
          setPermissionStatus(permission.state);
        });

        if (permission.state === 'denied') {
          throw new Error(
            'Camera permission denied. Please enable camera access in your browser settings.'
          );
        }
      }
    } catch (e) {
      console.warn('Could not check camera permissions:', e);
    }
  }, []);

  const initDevices = useCallback(async () => {
    try {
      console.log('Starting device initialization...');

      // First check permissions
      await checkPermissions();

      // Check if mediaDevices is available
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        throw new Error('Media devices API not supported in this browser.');
      }

      console.log('Enumerating all devices...');
      const all = await navigator.mediaDevices.enumerateDevices();
      console.log('All devices found:', all);

      const cams = all
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Camera ${i + 1}`,
        }));

      console.log('Video input devices found:', cams);

      if (!mountedRef.current) return;

      if (cams.length === 0) {
        // Try to get camera access to trigger permission prompt
        console.log(
          'No cameras found, trying to get camera access to trigger permissions...'
        );
        let testStream: MediaStream | null = null;
        try {
          testStream = await navigator.mediaDevices.getUserMedia({
            video: true,
          });
          setPermissionStatus('granted');
          console.log('Camera access granted, re-enumerating devices...');

          // Re-enumerate after getting permission
          const allAfterPermission =
            await navigator.mediaDevices.enumerateDevices();
          const camsAfterPermission = allAfterPermission
            .filter((d) => d.kind === 'videoinput')
            .map((d, i) => ({
              deviceId: d.deviceId,
              label: d.label || `Camera ${i + 1}`,
            }));

          console.log('Cameras after permission:', camsAfterPermission);

          if (camsAfterPermission.length > 0) {
            const back = camsAfterPermission.find((d) =>
              /back|rear|environment/i.test(d.label)
            );
            const newDeviceId =
              back?.deviceId || camsAfterPermission[0].deviceId;
            setSelectedDeviceId(newDeviceId);
            setDevices(camsAfterPermission);
            console.log('Selected device after permission:', newDeviceId);
            return;
          }
        } catch (e: any) {
          console.error('Failed to get camera access:', e);
          if (e.name === 'NotAllowedError') {
            setPermissionStatus('denied');
            throw new Error(
              'Camera access denied. Please allow camera permissions and refresh the page.'
            );
          } else if (e.name === 'NotFoundError') {
            throw new Error('No camera found on this device.');
          } else if (e.name === 'NotSupportedError') {
            throw new Error('Camera not supported on this device.');
          } else {
            throw new Error(`Camera access failed: ${e.message}`);
          }
        } finally {
          // Always stop the test stream
          if (testStream) {
            testStream.getTracks().forEach((track) => track.stop());
          }
        }

        throw new Error(
          'No camera devices found even after permission request.'
        );
      }

      // We have cameras, set them up
      setDevices(cams);

      if (cams.length > 0) {
        const back = cams.find((d) => /back|rear|environment/i.test(d.label));
        const newDeviceId = back?.deviceId || cams[0].deviceId;
        setSelectedDeviceId(newDeviceId);
        console.log('Selected device:', newDeviceId);
      }
    } catch (e) {
      handleError(e);
    }
  }, [handleError, checkPermissions]);

  useEffect(() => {
    initDevices();
  }, [initDevices]);

  const detectTorchSupport = useCallback(async () => {
    try {
      const stream = videoRef.current?.srcObject as MediaStream | null;
      const track = stream?.getVideoTracks()[0];
      if (!track || !mountedRef.current) {
        setTorchSupported(false);
        return;
      }
      let supported = false;
      if (track.getCapabilities) {
        const caps = track.getCapabilities() as any;
        supported = Boolean(caps?.torch);
      }
      if (!supported && 'ImageCapture' in window) {
        try {
          const ic = new (window as any).ImageCapture(track);
          const photo = await ic.getPhotoCapabilities();
          supported =
            Array.isArray(photo?.fillLightMode) &&
            (photo.fillLightMode.includes('flash') ||
              photo.fillLightMode.includes('torch'));
        } catch {
          /* ignore */
        }
      }
      if (mountedRef.current) setTorchSupported(supported);
    } catch {
      if (mountedRef.current) setTorchSupported(false);
    }
  }, []);

  const onDecode = useCallback(
    (result: any, err: any) => {
      if (!mountedRef.current || pausedRef.current) return;

      if (result) {
        const now = performance.now();
        if (now - lastResultAtRef.current > 500) {
          lastResultAtRef.current = now;
          onResult?.(result.getText(), result);
          if (
            'vibrate' in navigator &&
            typeof navigator.vibrate === 'function'
          ) {
            navigator.vibrate(30);
          }
        }
      } else if (err && err.name !== 'NotFoundException') {
        // Log, but do not stop/restart
        // console.debug('Non-notfound error:', err);
      }
    },
    [onResult]
  );

  const start = useCallback(async () => {
    if (!videoRef.current || !readerRef.current) return;
    if (isStarting || isRunning) return;

    const deviceId = selectedDeviceId;
    if (!deviceId) {
      handleError(new Error('No camera device selected'));
      return;
    }

    // Check permissions before starting
    if (permissionStatus === 'denied') {
      handleError(
        new Error(
          'Camera permission denied. Please allow camera access in your browser settings.'
        )
      );
      return;
    }

    try {
      setIsStarting(true);
      setTorchOn(false);
      setTorchSupported(false);
      pausedRef.current = false;

      controlsRef.current?.stop();
      controlsRef.current = null;
      stopActiveStream(videoRef.current);

      console.log('Starting scanner with device:', deviceId);

      // Force constraints mode with gentle frame rate to avoid flapping
      const constraints: MediaStreamConstraints = {
        audio: false,
        video: {
          deviceId: { exact: deviceId },
          frameRate: { ideal: 24, max: 24 },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      };

      let controls: IScannerControls | null = null;
      try {
        console.log('Attempting to start with exact device constraints');
        controls = await readerRef.current.decodeFromConstraints(
          constraints,
          videoRef.current,
          onDecode
        );
      } catch (e: any) {
        console.warn(
          'Failed with exact device constraints, trying fallback:',
          e.name
        );
        // Fallback: relax deviceId; prefer environment
        if (e?.name === 'OverconstrainedError' || e?.name === 'NotFoundError') {
          try {
            controls = await readerRef.current.decodeFromConstraints(
              {
                audio: false,
                video: {
                  facingMode: { ideal: 'environment' },
                  frameRate: { ideal: 24, max: 24 },
                  width: { ideal: 1280 },
                  height: { ideal: 720 },
                },
              },
              videoRef.current,
              onDecode
            );
            console.log('Successfully started with environment fallback');
          } catch (fallbackError: any) {
            console.warn(
              'Environment fallback also failed:',
              fallbackError.name
            );
            // Final fallback: any camera
            controls = await readerRef.current.decodeFromConstraints(
              {
                audio: false,
                video: true,
              },
              videoRef.current,
              onDecode
            );
            console.log('Successfully started with basic fallback');
          }
        } else {
          throw e;
        }
      }

      if (!mountedRef.current) {
        controls?.stop();
        stopActiveStream(videoRef.current);
        return;
      }
      if (!controls) throw new Error('Failed to start scanner');

      controlsRef.current = controls;

      // Ensure the video actually plays
      const video = videoRef.current;
      await new Promise<void>((resolve) => {
        if (video.readyState >= 1) resolve();
        else {
          const onLoaded = () => {
            video.removeEventListener('loadedmetadata', onLoaded);
            resolve();
          };
          video.addEventListener('loadedmetadata', onLoaded, { once: true });
        }
      });
      try {
        await video.play();
      } catch {
        /* might need gesture */
      }

      setIsRunning(true);

      setTimeout(() => {
        if (mountedRef.current) detectTorchSupport();
      }, 300);
    } catch (e) {
      handleError(e);
      if (mountedRef.current) setIsRunning(false);
    } finally {
      if (mountedRef.current) setIsStarting(false);
    }
  }, [
    isStarting,
    isRunning,
    selectedDeviceId,
    handleError,
    detectTorchSupport,
    onDecode,
  ]);

  const stop = useCallback(() => {
    pausedRef.current = true;
    controlsRef.current?.stop();
    controlsRef.current = null;
    stopActiveStream(videoRef.current);
    setIsRunning(false);
    setTorchOn(false);
    setTorchSupported(false);
  }, []);

  useEffect(() => {
    if (!selectedDeviceId || !mountedRef.current) return;
    // Delay start slightly to avoid flaps during device enumeration
    const tid = setTimeout(() => start(), 120);
    return () => clearTimeout(tid);
  }, [selectedDeviceId, start]);

  const toggleTorch = useCallback(async () => {
    if (!isRunning || !torchSupported) return;
    try {
      const stream = videoRef.current?.srcObject as MediaStream | null;
      const track = stream?.getVideoTracks()[0];
      if (!track) return;

      const next = !torchOn;
      try {
        await track.applyConstraints({ advanced: [{ torch: next } as any] });
        if (mountedRef.current) setTorchOn(next);
        return;
      } catch {
        // fallback
      }

      if ('ImageCapture' in window) {
        try {
          const ic = new (window as any).ImageCapture(track);
          if (ic.setOptions) {
            await ic.setOptions({
              fillLightMode: next ? 'flash' : 'off',
            });
            if (mountedRef.current) setTorchOn(next);
            return;
          }
        } catch {
          /* ignore */
        }
      }

      throw new Error('Torch control not supported');
    } catch (e) {
      handleError(e);
    }
  }, [isRunning, torchSupported, torchOn, handleError]);

  const handleDeviceChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newId = e.target.value;
      // Avoid double-binding by stopping first
      if (isRunning || isStarting) {
        controlsRef.current?.stop();
        controlsRef.current = null;
        stopActiveStream(videoRef.current);
        setIsRunning(false);
      }
      setSelectedDeviceId(newId);
    },
    [isRunning, isStarting]
  );

  return (
    <div
      className={`w-full max-w-md mx-auto space-y-3 bg-white rounded-xl shadow p-4 ${className}`}
    >
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

      <div className='relative aspect-[3/4] w-full overflow-hidden rounded-lg bg-black'>
        <video
          ref={videoRef}
          className='h-full w-full object-cover'
          muted
          playsInline
          autoPlay
        />
        <div className='pointer-events-none absolute inset-0 flex items-center justify-center'>
          <div className='h-44 w-44 rounded-md border-2 border-white/80 shadow-lg' />
        </div>

        {/* Status indicators */}
        <div className='absolute top-2 left-2 space-y-1'>
          {permissionStatus === 'denied' && (
            <div className='bg-red-500 text-white px-2 py-1 rounded text-xs font-medium'>
              Camera blocked
            </div>
          )}
          {permissionStatus === 'prompt' && (
            <div className='bg-yellow-500 text-white px-2 py-1 rounded text-xs font-medium'>
              Allow camera
            </div>
          )}
          {devices.length === 0 && permissionStatus !== 'denied' && (
            <div className='bg-blue-500 text-white px-2 py-1 rounded text-xs font-medium'>
              No cameras found
            </div>
          )}
        </div>

        {isRunning && (
          <div className='absolute top-2 right-2 bg-green-500 text-white px-2 py-1 rounded text-xs font-medium'>
            Scanning...
          </div>
        )}
      </div>

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
          {(permissionStatus === 'denied' || devices.length === 0) && (
            <button
              className='rounded bg-orange-500 px-4 py-2 text-white hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
              onClick={() => {
                setDevices([]);
                setSelectedDeviceId('');
                initDevices();
              }}
              disabled={isStarting}
            >
              Retry
            </button>
          )}
          <button
            className='rounded bg-blue-500 px-4 py-2 text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
            onClick={async () => {
              try {
                console.log('Testing camera access...');
                const stream = await navigator.mediaDevices.getUserMedia({
                  video: true,
                });
                console.log('Camera test successful:', stream);
                alert('Camera test successful! Camera is working.');
                stream.getTracks().forEach((track) => track.stop());
              } catch (e: any) {
                console.error('Camera test failed:', e);
                alert(`Camera test failed: ${e.message}`);
              }
            }}
            disabled={isStarting}
          >
            Test Camera
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
