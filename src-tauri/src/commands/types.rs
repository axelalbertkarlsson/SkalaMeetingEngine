use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct OperationAck {
  pub ok: bool,
  pub message: String,
}
