type IconName = 'console' | 'settings' | 'close' | 'map' | 'plus' | 'minus' | 'fit' | 'play' | 'reset' | 'app'

const paths: Record<IconName, string[]> = {
  console: ['M4 5h16v14H4z', 'm8 9 3 3-3 3', 'M13 15h3'],
  settings: ['m9 3-.6 2.4-2 .9L4 5.6 1.8 9.4l1.8 1.7v2L1.8 15 4 18.8l2.4-.7 2 .9L9 21h6l.6-2 2-.9 2.4.7 2.2-3.8-1.8-1.9v-2l1.8-1.7L20 5.6l-2.4.7-2-.9L15 3z', 'M15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0'],
  close: ['m6 6 12 12', 'M18 6 6 18'],
  map: ['M3 4h6v6H3z', 'M15 14h6v6h-6z', 'M9 7h9v7', 'M6 10v7h9'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  fit: ['M9 4H4v5', 'M15 4h5v5', 'M20 15v5h-5', 'M9 20H4v-5'],
  play: ['m8 4 12 8-12 8z'],
  reset: ['M3 4v6h6', 'M3 10a9 9 0 1 1 2 8'],
  app: ['M3 4h18v16H3z', 'M3 9h18', 'M8 9v11'],
}

function CanvasIcon({ name }: { name: IconName }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths[name].map((path, index) => <path key={index} d={path} />)}
  </svg>
}

export default CanvasIcon
