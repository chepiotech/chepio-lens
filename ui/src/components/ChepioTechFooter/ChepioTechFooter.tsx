// Styles
import './ChepioTechFooter.css'

function ChepioTechFooter() {
  return (
    <footer className="chepio-footer">
      <div className="chepio-footer__inner">
        <a
          href="https://chepio.tech"
          target="_blank"
          rel="noopener noreferrer"
          className="chepio-footer__link"
          aria-label="Developed by Chepio"
        >
          <img src="/images/chepio-tech/logo_designed.svg" alt="chepio.tech" className="chepio-footer__logo" />
        </a>
      </div>
    </footer>
  )
}

export default ChepioTechFooter
