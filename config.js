// Se metti qui il tuo Client Token Mapillary, chi apre il sito non dovrà inserirlo.
// È un token "client" pensato per stare nel browser: non è un segreto.
window.GEO_CONFIG = {
  mapillaryToken: '',

  // Segnalazioni anonime (solo dati tecnici): indirizzo "formResponse" di un Modulo Google
  // e campo dove scrivere il rapporto, per esempio
  // 'https://docs.google.com/forms/d/e/1FAIpQL.../formResponse' e 'entry.123456789'.
  // Lasciati vuoti, le segnalazioni restano solo nel browser di chi gioca.
  reportFormUrl: 'https://docs.google.com/forms/d/e/1FAIpQLSfj0pFeq2UfV806qk0kQ_Szzru51CgmP354XtZaYDp0OefE_Q/formResponse',
  reportFormEntry: 'entry.1863132058',
  // Con Street View, ogni round manda anche un registro leggero, per confrontare i posti
  // riusciti con quelli segnalati. false per spegnerlo.
  logAllRounds: true,
};
