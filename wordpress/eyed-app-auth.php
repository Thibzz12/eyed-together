<?php
/**
 * Plugin Name: EyeD Together — Pont de connexion (SSO)
 * Description: Connecte l'app à l'intranet sans mot de passe (compatible Magic Login).
 *              /?eyed_bridge=1 : si connecté -> renvoie un jeton signé à l'app ;
 *              sinon -> login intranet, puis retour automatique vers l'app (via cookie d'intention).
 * Version: 3.0
 *
 * ⚠️ EYED_APP_SECRET = identique à WP_APP_SECRET dans le .env de l'app. NE JAMAIS committer
 *    la vraie valeur ici : elle vit uniquement dans le Code Snippet posé sur WordPress et
 *    dans le .env local (tous deux hors de ce dépôt Git).
 * ⚠️ EYED_APP_CALLBACK = URL de retour de l'app (localhost en dev, vrai domaine en prod).
 */

if (!defined('ABSPATH')) {
    exit;
}

if (!defined('EYED_APP_SECRET')) {
    define('EYED_APP_SECRET', 'REMPLACE_MOI_PAR_UN_SECRET_LONG_ET_ALEATOIRE');
}
if (!defined('EYED_APP_CALLBACK')) {
    define('EYED_APP_CALLBACK', 'http://localhost:8000/auth/wordpress-callback');
}

/**
 * Génère le jeton signé pour l'utilisateur connecté et le renvoie à l'app.
 */
function eyed_send_token() {
    $user = wp_get_current_user();
    $payload = array(
        'id'    => $user->ID,
        'email' => $user->user_email,
        'name'  => $user->display_name,
        'roles' => array_values($user->roles),
        'exp'   => time() + 120, // 2 minutes
    );
    $b64   = rtrim(strtr(base64_encode(wp_json_encode($payload)), '+/', '-_'), '=');
    $sig   = hash_hmac('sha256', $b64, EYED_APP_SECRET);
    wp_redirect(EYED_APP_CALLBACK . '?token=' . urlencode($b64 . '.' . $sig));
    exit;
}

add_action('init', function () {

    // 1) Démarrage du pont : /?eyed_bridge=1
    if (isset($_GET['eyed_bridge'])) {
        if (is_user_logged_in()) {
            eyed_send_token(); // déjà connecté -> direct
        }
        // Pas connecté : on note l'intention d'aller vers l'app, puis login intranet.
        setcookie('eyed_bridge_intent', '1', time() + 600, '/'); // 10 min
        wp_redirect(wp_login_url(home_url('/?eyed_bridge=1')));
        exit;
    }

    // 2) Après connexion : si l'intention est présente, on rattrape et on renvoie vers l'app.
    //    (Magic Login peut renvoyer n'importe où : ce filet de sécurité complète le parcours.)
    if (is_user_logged_in()
        && !empty($_COOKIE['eyed_bridge_intent'])
        && !wp_doing_ajax()
        && !(defined('REST_REQUEST') && REST_REQUEST)
    ) {
        setcookie('eyed_bridge_intent', '', time() - 3600, '/'); // efface le cookie
        eyed_send_token();
    }
});
