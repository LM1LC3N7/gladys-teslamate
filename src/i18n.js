// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature names, the status of the
// integration and the answers of the button. None of them ever carries the
// password of the broker, the VIN or a position.
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';

const PACKET_KB = Math.round(LIMITS.packetBytes / 1024);

const both = (en, fr) => ({ en, fr });

/** "45 s", "5 min", "2 h". */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return `${seconds} s`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

/** Feature names, by language (the keys of src/car.js FEATURES). */
export const FEATURE_NAMES = {
  en: {
    battery_level: 'Battery level',
    usable_battery_level: 'Usable battery level',
    rated_range: 'Rated range',
    estimated_range: 'Estimated range',
    charging_state: 'Charging state',
    plugged_in: 'Plugged in',
    charger_power: 'Charging power',
    charger_current: 'Charging current',
    charger_voltage: 'Charging voltage',
    charge_energy_added: 'Energy added (last charge)',
    charge_limit: 'Charge limit',
    inside_temperature: 'Inside temperature',
    outside_temperature: 'Outside temperature',
    climate_on: 'Climate on',
    odometer: 'Odometer',
    locked: 'Locked',
    sentry_mode: 'Sentry mode',
    doors_open: 'Doors open',
    trunk_open: 'Trunk open',
    frunk_open: 'Frunk open',
    windows_open: 'Windows open',
    tyre_front_left: 'Tyre pressure front left',
    tyre_front_right: 'Tyre pressure front right',
    tyre_rear_left: 'Tyre pressure rear left',
    tyre_rear_right: 'Tyre pressure rear right',
    state: 'State (TeslaMate)',
    geofence: 'Geofence',
    position: 'Position (rounded)',
  },
  fr: {
    battery_level: 'Niveau de batterie',
    usable_battery_level: 'Niveau de batterie utilisable',
    rated_range: 'Autonomie nominale',
    estimated_range: 'Autonomie estimée',
    charging_state: 'État de charge',
    plugged_in: 'Branchée',
    charger_power: 'Puissance de charge',
    charger_current: 'Courant de charge',
    charger_voltage: 'Tension de charge',
    charge_energy_added: 'Énergie ajoutée (dernière charge)',
    charge_limit: 'Limite de charge',
    inside_temperature: 'Température intérieure',
    outside_temperature: 'Température extérieure',
    climate_on: 'Climatisation en marche',
    odometer: 'Compteur kilométrique',
    locked: 'Verrouillée',
    sentry_mode: 'Mode Sentinelle',
    doors_open: 'Portes ouvertes',
    trunk_open: 'Coffre ouvert',
    frunk_open: 'Coffre avant ouvert',
    windows_open: 'Fenêtres ouvertes',
    tyre_front_left: 'Pression pneu avant gauche',
    tyre_front_right: 'Pression pneu avant droit',
    tyre_rear_left: 'Pression pneu arrière gauche',
    tyre_rear_right: 'Pression pneu arrière droit',
    state: 'État (TeslaMate)',
    geofence: 'Zone (geofence)',
    position: 'Position (arrondie)',
  },
};

const PROBLEMS = {
  empty: both(
    'Type the address of the MQTT broker TeslaMate publishes to.',
    "Saisissez l'adresse du broker MQTT où publie TeslaMate.",
  ),
  invalid: both(
    'The broker address is not valid: an IP address or a name, or mqtt://address:port, mqtts://address:port.',
    "L'adresse du broker n'est pas valide : une adresse IP ou un nom, ou mqtt://adresse:port, mqtts://adresse:port.",
  ),
  credentials: both(
    'Type the user name and the password in their own fields, not in the broker address.',
    "Saisissez l'utilisateur et le mot de passe dans leurs champs, pas dans l'adresse du broker.",
  ),
  namespace: both(
    'The namespace is not valid: the MQTT_NAMESPACE of TeslaMate, letters, digits, _ and - only (not "default").',
    "L'espace de noms n'est pas valide : le MQTT_NAMESPACE de TeslaMate, lettres, nombres, _ et - seulement (pas « default »).",
  ),
  control: both(
    'The user name or the password holds a line break or a control character.',
    "L'utilisateur ou le mot de passe contient un retour à la ligne ou un caractère de contrôle.",
  ),
  password_without_user: both(
    'A password without a user name: type the user name of the broker too.',
    "Un mot de passe sans utilisateur : saisissez aussi l'utilisateur du broker.",
  ),
};

/** Status texts (multi-language objects for setConnectionStatus). */
export const T = {
  problem: (key) => PROBLEMS[key] ?? PROBLEMS.invalid,
  configUnread: (wait) =>
    both(
      `The configuration could not be read from Gladys: next try in ${wait}.`,
      `La configuration n'a pas pu être lue dans Gladys : nouvel essai dans ${wait}.`,
    ),
  connecting: both('Connecting to the MQTT broker...', 'Connexion au broker MQTT...'),
  unreachable: (reason, wait = '10 s') =>
    both(
      `MQTT broker unreachable (${reason}): next try in ${wait}.`,
      `Broker MQTT injoignable (${reason}) : nouvel essai dans ${wait}.`,
    ),
  dataUnreadable: (wait) =>
    both(
      `The state of the integration in /data could not be read: next try in ${wait}.`,
      `L'état de l'intégration dans /data n'a pas pu être lu : nouvel essai dans ${wait}.`,
    ),
  lost: both(
    'Connection to the MQTT broker lost: reconnecting.',
    'Connexion au broker MQTT perdue : reconnexion.',
  ),
  refused: (reason, wait) =>
    both(
      `The MQTT broker refused the connection (${reason}): no new try before ${wait}. Check the user name and the password, or press "Test the connection".`,
      `Le broker MQTT a refusé la connexion (${reason}) : pas de nouvel essai avant ${wait}. Vérifiez l'utilisateur et le mot de passe, ou appuyez sur « Tester la connexion ».`,
    ),
  stopped: (wait) =>
    both(
      `Stopped after a refusal of the credentials: next try in ${wait}, or press "Test the connection".`,
      `Arrêté après un refus des identifiants : nouvel essai dans ${wait}, ou appuyez sur « Tester la connexion ».`,
    ),
  waiting: (prefix) =>
    both(
      `Connected to the broker, waiting for TeslaMate (topics ${prefix}...).`,
      `Connecté au broker, en attente de TeslaMate (sujets ${prefix}...).`,
    ),
  noData: (prefix) =>
    both(
      `Connected to the broker, but nothing from TeslaMate on ${prefix}... Check MQTT_HOST and MQTT_NAMESPACE of TeslaMate (see the guide).`,
      `Connecté au broker, mais rien de TeslaMate sur ${prefix}... Vérifiez MQTT_HOST et MQTT_NAMESPACE de TeslaMate (voir le guide).`,
    ),
  connected: (cars, { protocol3 = false, unhealthy = 0, capped = 0 } = {}) => {
    const en = [`Connected: ${cars} car(s) seen in TeslaMate.`];
    const fr = [`Connecté : ${cars} voiture(s) vue(s) dans TeslaMate.`];
    if (unhealthy > 0) {
      en.push(`TeslaMate reports a problem for ${unhealthy} car(s) (healthy: false).`);
      fr.push(`TeslaMate signale un problème pour ${unhealthy} voiture(s) (healthy : false).`);
    }
    if (capped > 0) {
      en.push(`${capped} other car id(s) ignored (${LIMITS.cars} at most).`);
      fr.push(`${capped} autre(s) numéro(s) de voiture ignoré(s) (${LIMITS.cars} au plus).`);
    }
    if (protocol3) {
      en.push(
        `The broker speaks MQTT 3.1.1 only: messages over ${PACKET_KB} KB cut the connection.`,
      );
      fr.push(
        `Le broker ne parle que MQTT 3.1.1 : un message de plus de ${PACKET_KB} Ko coupe la connexion.`,
      );
    }
    return both(en.join(' '), fr.join(' '));
  },
};

/** Answers of the "Test the connection" button. */
export const TEST = {
  tooSoon: both(
    'Wait a few seconds between two tests.',
    'Attendez quelques secondes entre deux tests.',
  ),
  refused: (reason) =>
    both(
      `The broker refused the connection: ${reason}. Check the user name and the password.`,
      `Le broker a refusé la connexion : ${reason}. Vérifiez l'utilisateur et le mot de passe.`,
    ),
  ok: (names) =>
    both(
      `Connected. TeslaMate publishes ${names.length} car(s): ${names.join(', ')}.`,
      `Connecté. TeslaMate publie ${names.length} voiture(s) : ${names.join(', ')}.`,
    ),
  none: (prefix) =>
    both(
      `Connected to the broker, but no TeslaMate car on ${prefix}... within 10 s. Check MQTT_HOST and MQTT_NAMESPACE of TeslaMate.`,
      `Connecté au broker, mais aucune voiture TeslaMate sur ${prefix}... en 10 s. Vérifiez MQTT_HOST et MQTT_NAMESPACE de TeslaMate.`,
    ),
};

/** The transport badge when TeslaMate says its logger is unhealthy for a car. */
export const UNHEALTHY = both(
  'TeslaMate reports a problem with this car (healthy: false).',
  'TeslaMate signale un problème avec cette voiture (healthy : false).',
);
