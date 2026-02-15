use thiserror::Error;

#[derive(Debug, Error)]
pub enum MercuryError {
    #[error("internal server error")]
    Internal(#[from] anyhow::Error),
}
