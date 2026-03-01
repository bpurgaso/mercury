import React from 'react'

interface UnverifiedReportBannerProps {
  isEncrypted: boolean
}

export function UnverifiedReportBanner({ isEncrypted }: UnverifiedReportBannerProps): React.ReactElement {
  if (isEncrypted) {
    return (
      <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-lg text-yellow-400">&#9888;</span>
          <div>
            <p className="text-sm font-semibold text-yellow-300">Cannot be cryptographically verified</p>
            <p className="mt-1 text-xs leading-relaxed text-yellow-200/80">
              This report includes content from an end-to-end encrypted channel. Because messages
              are encrypted, there is no cryptographic proof that the reported content is authentic.
              The reporter could have modified the message before submitting this report. Consider
              corroborating with metadata, message patterns, and other reports before taking action.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-lg text-green-400">&#10003;</span>
        <div>
          <p className="text-sm font-semibold text-green-300">Verified — server has original message</p>
          <p className="mt-1 text-xs leading-relaxed text-green-200/80">
            The server retains the original message for standard channels. You can compare the
            report evidence against the server&apos;s copy.
          </p>
        </div>
      </div>
    </div>
  )
}
