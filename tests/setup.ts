// A throwaway key, so the Change hook saves as an encrypted secret setting
// as it does on a real site (EmDash requires EMDASH_ENCRYPTION_KEY for one).
// Not a secret: it encrypts nothing outside these tests.
process.env.EMDASH_ENCRYPTION_KEY =
  "emdash_enc_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
