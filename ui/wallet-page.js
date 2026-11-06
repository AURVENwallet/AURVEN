import {connectDraftReview} from './transfer-ui.js';
import {walletDraftActions} from './vault-ui.js';
import './browser-trial-ui.js';
import './network-account-ui.js';

connectDraftReview(walletDraftActions);
if (location.hash === '#localStart') document.getElementById('localStart').open = true;
