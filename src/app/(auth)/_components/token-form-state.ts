/** What the invitation and reset server actions hand back to their forms. Never carries a password or a token. */
export type TokenFormState = {
  /** A message for the whole form. */
  error?: string;
  /** The link cannot be used (any reason, one message): the form is replaced by the generic card's words. */
  invalid?: boolean;
  fieldErrors?: { password?: string; confirmPassword?: string };
};
