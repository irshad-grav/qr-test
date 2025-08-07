import { useState } from 'react';
import './App.css';
import CodeScanner from './scanner';

function App() {
  const [lastResult, setLastResult] = useState<string>('');

  return (
    <div className='min-h-screen bg-gray-50 p-4'>
      <h1 className='mb-4 text-2xl font-semibold'>QR + Barcode Scanner</h1>

      <CodeScanner
        onResult={(text) => {
          setLastResult(text);
        }}
        onError={(err) => {
          console.error(err);
          alert('Camera error. Check permissions and try again.');
        }}
      />

      <div className='mt-4 rounded bg-white p-4 shadow'>
        <h2 className='mb-2 text-lg font-medium'>Last result</h2>
        <p className='font-mono break-all text-sm text-gray-800'>
          {lastResult || '—'}
        </p>
      </div>
    </div>
  );
}

export default App;
