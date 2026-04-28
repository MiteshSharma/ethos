import { Empty } from 'antd';

// 26.W3 placeholder — full 5-step flow lives here. v0.W1 only renders the
// route so the app shell tests cleanly.

export function Onboarding() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
      <Empty description="Onboarding flow lands in 26.W3." />
    </div>
  );
}
