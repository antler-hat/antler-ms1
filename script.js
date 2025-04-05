// ----- SYNTH PANEL ELEMENTS -----
const synthPanel = document.getElementById('synth-panel');
const knobs = synthPanel.querySelectorAll('.knob');
const switches = synthPanel.querySelectorAll('.switch');
const powerLed = document.getElementById('power-led');
const powerButton = document.getElementById('power-button');

// ----- AUDIO CONTEXT & NODES -----
let audioContext;
let masterGain;
let vco1, vco2; // Persistent Oscillators
let vco1Gain, vco2Gain;
let noiseSource, noiseGain; // Persistent Noise Source
let filter;
let vcaGainNode; // Master VCA controlled by envelope
let lfo, vco1LfoGain, vco2LfoGain, vcfLfoGain, vcaLfoGain;
let vcfEnvGain; // Controls VCF Env -> Filter Freq amount
let reverb, reverbWetGain, reverbDryGain;

let isAudioInitialized = false;
let isAudioResumed = false; // Tracks if user interaction has successfully resumed context

// ----- SYNTH PARAMETERS -----
const params = {
    masterTune: 0, // In cents
    portamentoTime: 0, // Glide time in seconds
    keyFollow: 0, // 0 = off, 1 = 100% tracking (adjust implementation for %)
    legato: 1, // 1 = legato (no env retrigger on note change), 0 = retrigger always
    vco1: { octave: 2, type: 'sawtooth' }, // Octave Index
    vco2: { octave: 2, type: 'sawtooth', detune: { value: 0 } }, // Detune in cents
    vcfEnv: { attack: 0.01, decay: 0.1, sustain: 0.8, release: 0.2 },
    vcaEnv: { attack: 0.01, decay: 0.1, sustain: 1.0, release: 0.2 },
    lfo: { frequency: { value: 5 }, type: 'square' },
    vco1Gain: { gain: { value: 0.7 } },
    vco2Gain: { gain: { value: 0.7 } },
    noiseGain: { gain: { value: 0 } },
    filter: { frequency: { value: 20000 }, Q: { value: 1 }, type: 'lowpass' },
    vco1LfoGain: { gain: { value: 0 } }, // LFO -> VCO1 Pitch Mod Depth (cents)
    vco2LfoGain: { gain: { value: 0 } }, // LFO -> VCO2 Pitch Mod Depth (cents)
    vcfLfoGain: { gain: { value: 0 } }, // LFO -> Filter Freq Mod Depth (Hz)
    vcaLfoGain: { gain: { value: 0 } }, // LFO -> VCA Mod Depth (Gain units 0-1)
    vcfEnvGain: { gain: { value: 4000 } }, // VCF Env -> Filter Freq Mod Depth (Hz)
    reverbWetGain: { gain: { value: 0.2 } },
    masterGain: { gain: { value: 0.5 } }
};

// ----- CONSTANTS & MAPPINGS -----
const octaveSteps = [32, 16, 8, 4, 2]; // For display
const octaveMultipliers = [1/8, 1/4, 1/2, 1, 2]; // For calculation
const vcoWaveforms = ['triangle', 'sawtooth', 'square', 'sine']; // Possible values
const vcoShapeIndicators = ['△', '⩘', '⊓', '∿']; // Display text
const lfoWaveforms = ['square', 'sawtooth', 'triangle', 'sine'];
const lfoShapeIndicators = ['⊓', '⩘', '△', '∿'];

// ----- MONO SYNTH STATE -----
let pressedKeys = {}; // Tracks currently physically held keys { 'KeyCode': true }
let currentNote = null; // The MIDI note number currently sounding (or null if silent)
let currentFrequency = 0; // Base frequency of the currentNote (before octave/detune)

const keyToNoteMap = {
    'KeyA': 60, 'KeyW': 61, 'KeyS': 62, 'KeyE': 63, 'KeyD': 64, 'KeyF': 65,
    'KeyT': 66, 'KeyG': 67, 'KeyY': 68, 'KeyH': 69, 'KeyU': 70, 'KeyJ': 71,
    'KeyK': 72,
};

// ----- UTILITY FUNCTIONS -----
function midiToFreq(midiNote) {
    // Master tune is handled by oscillator detune parameter now
    return 440 * Math.pow(2, (midiNote - 69) / 12);
}

function calculateVcoFrequency(baseFreq, vcoParams) {
    let octaveIndex = vcoParams.octave;
     // --- Validation ---
    if (typeof octaveIndex !== 'number' || isNaN(octaveIndex) || octaveIndex < 0 || octaveIndex >= octaveMultipliers.length) {
        console.warn(`Invalid VCO Octave Index (${octaveIndex}), defaulting to 2 (8')`);
        octaveIndex = 2;
        vcoParams.octave = octaveIndex; // Correct the params object too
    }
    const freq = baseFreq * octaveMultipliers[octaveIndex];
    // Clamp final frequency for safety
    const safeFreq = Math.max(20, Math.min(audioContext.sampleRate / 2, freq));
     if (!isFinite(safeFreq)) {
        console.error("FATAL: Calculated VCO frequency is non-finite!", freq, baseFreq, octaveIndex);
        return 440; // Return a safe default
    }
    return safeFreq;
}

// ----- AUDIO CONTEXT & INITIALIZATION -----
async function ensureAudioContextResumed() {
    if (!audioContext) {
        console.error("Attempted to resume context, but it's not initialized.");
        return false;
    }
    if (audioContext.state === 'running') {
        if (!isAudioResumed) isAudioResumed = true;
        return true;
    }
    if (audioContext.state === 'suspended') {
        console.log("AudioContext suspended. Attempting to resume...");
        try {
            await audioContext.resume();
            if (audioContext.state === 'running') {
                console.log("AudioContext Resumed successfully.");
                isAudioResumed = true;
                if (!powerLed.classList.contains('on')) powerLed.classList.add('on');
                return true;
            } else {
                console.warn("AudioContext state is still not 'running' after resume attempt:", audioContext.state);
                isAudioResumed = false;
                return false;
            }
        } catch (e) {
            console.error("Error resuming AudioContext:", e);
            isAudioResumed = false;
            return false;
        }
    }
    console.warn("AudioContext in unexpected state:", audioContext.state);
    isAudioResumed = false;
    return false;
}

function initAudio() {
    if (isAudioInitialized) return;
    console.log("Initializing AudioContext...");
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        isAudioInitialized = true;
        console.log("Initial AudioContext State:", audioContext.state);

        // --- Create Nodes (Persistent Nodes First) ---
        masterGain = audioContext.createGain();
        params.masterGain.node = masterGain;

        // VCOs (Persistent)
        vco1 = audioContext.createOscillator(); vco1.type = params.vco1.type;
        vco2 = audioContext.createOscillator(); vco2.type = params.vco2.type;
        params.vco1.node = vco1; params.vco2.node = vco2;

        vco1Gain = audioContext.createGain(); vco2Gain = audioContext.createGain();
        params.vco1Gain.node = vco1Gain; params.vco2Gain.node = vco2Gain;

        // Noise (Persistent)
        const bufferSize = audioContext.sampleRate * 2; // 2 seconds of noise
        const noiseBuffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) output[i] = Math.random() * 2 - 1;
        noiseSource = audioContext.createBufferSource();
        noiseSource.buffer = noiseBuffer;
        noiseSource.loop = true;
        noiseGain = audioContext.createGain();
        params.noiseGain.node = noiseGain;
        params.noiseSource = { node: noiseSource }; // Store reference if needed

        // LFO
        lfo = audioContext.createOscillator();
        params.lfo.node = lfo;
        vco1LfoGain = audioContext.createGain(); vco2LfoGain = audioContext.createGain();
        vcfLfoGain = audioContext.createGain(); vcaLfoGain = audioContext.createGain();
        params.vco1LfoGain.node = vco1LfoGain; params.vco2LfoGain.node = vco2LfoGain;
        params.vcfLfoGain.node = vcfLfoGain; params.vcaLfoGain.node = vcaLfoGain;

        // Filter
        filter = audioContext.createBiquadFilter();
        params.filter.node = filter;

        // VCF Envelope Gain Control
        vcfEnvGain = audioContext.createGain();
        params.vcfEnvGain.node = vcfEnvGain;

        // VCA (The Main Gate)
        vcaGainNode = audioContext.createGain();
        vcaGainNode.gain.value = 0; // Start silent

        // Reverb
        reverb = audioContext.createConvolver();
        reverbWetGain = audioContext.createGain(); reverbDryGain = audioContext.createGain();
        params.reverbWetGain.node = reverbWetGain; params.reverbDryGain = { node: reverbDryGain };

        // --- Set Initial Parameters from `params` object ---
        // Gains
        masterGain.gain.value = params.masterGain.gain.value;
        vco1Gain.gain.value = params.vco1Gain.gain.value;
        vco2Gain.gain.value = params.vco2Gain.gain.value;
        noiseGain.gain.value = params.noiseGain.gain.value;
        vco1LfoGain.gain.value = params.vco1LfoGain.gain.value; // These are mod depths (cents/Hz/gain)
        vco2LfoGain.gain.value = params.vco2LfoGain.gain.value;
        vcfLfoGain.gain.value = params.vcfLfoGain.gain.value;
        vcaLfoGain.gain.value = params.vcaLfoGain.gain.value;
        vcfEnvGain.gain.value = params.vcfEnvGain.gain.value; // Env mod depth (Hz)
        const wetLevel = params.reverbWetGain.gain.value;
        reverbWetGain.gain.value = wetLevel;
        reverbDryGain.gain.value = 1.0 - wetLevel;

        // Oscillator/Filter Settings
        lfo.frequency.value = params.lfo.frequency.value;
        lfo.type = params.lfo.type;
        // VCO frequencies & detune will be set by noteOn/Off
        vco1.detune.value = params.masterTune; // Apply master tune
        vco2.detune.value = params.masterTune + params.vco2.detune.value; // Apply master + VCO2 detune
        filter.type = params.filter.type;
        filter.frequency.value = params.filter.frequency.value; // Base cutoff
        filter.Q.value = params.filter.Q.value;


        // --- Create Reverb Impulse ---
        const reverbTime = 1.5, decay = 2.0, sampleRate = audioContext.sampleRate;
        const length = sampleRate * reverbTime;
        const impulse = audioContext.createBuffer(2, length, sampleRate);
        const impulseL = impulse.getChannelData(0), impulseR = impulse.getChannelData(1);
        for (let i = 0; i < length; i++) {
            const envelope = Math.pow(1 - i / length, decay);
            impulseL[i] = (Math.random() * 2 - 1) * envelope;
            impulseR[i] = (Math.random() * 2 - 1) * envelope;
        }
        reverb.buffer = impulse;

        // --- Connect Audio Graph ---
        // LFO -> Mod Destinations
        lfo.connect(vco1LfoGain); lfo.connect(vco2LfoGain);
        lfo.connect(vcfLfoGain); lfo.connect(vcaLfoGain);
        vco1LfoGain.connect(vco1.detune); // LFO modulates detune (in cents)
        vco2LfoGain.connect(vco2.detune); // LFO modulates detune (in cents)
        vcfLfoGain.connect(filter.frequency); // LFO modulates filter cutoff
        vcaLfoGain.connect(vcaGainNode.gain); // LFO modulates VCA gain (tremolo)

        // Env -> Filter Freq
        vcfEnvGain.connect(filter.frequency); // Env modulates filter cutoff

        // Sound Sources -> Source Gains
        vco1.connect(vco1Gain);
        vco2.connect(vco2Gain);
        noiseSource.connect(noiseGain);

        // Source Gains -> Filter
        vco1Gain.connect(filter);
        vco2Gain.connect(filter);
        noiseGain.connect(filter);

        // Filter -> VCA (Gate)
        filter.connect(vcaGainNode);

        // VCA -> Reverb Send & Dry Path
        vcaGainNode.connect(reverbDryGain);
        vcaGainNode.connect(reverb);

        // Reverb Wet/Dry -> Master Gain
        reverb.connect(reverbWetGain);
        reverbDryGain.connect(masterGain);
        reverbWetGain.connect(masterGain);

        // Master Gain -> Output
        masterGain.connect(audioContext.destination);

        // --- Start Persistent Oscillators ---
        lfo.start();
        vco1.start();
        vco2.start();
        noiseSource.start();

        // --- Final State Check ---
        if (audioContext.state === 'running') {
            isAudioResumed = true;
            powerLed.classList.add('on');
            console.log("Audio graph initialized and context is running.");
        } else {
            isAudioResumed = false;
            powerLed.classList.remove('on');
            console.log("Audio graph initialized, but context is suspended. Requires user interaction.");
        }

    } catch (e) {
        console.error("Error initializing Web Audio API:", e);
        alert("Web Audio API initialization failed. Your browser might not support it or an error occurred.");
        isAudioInitialized = false;
    }
}

// ----- ENVELOPE FUNCTIONS -----
// Trigger the Attack-Decay-Sustain stages
function triggerEnvelope(envParams, targetParam, sustainValue, now, isVcf = false, baseNote = 69) {
    if (!audioContext || !targetParam) return;
    const { attack, decay } = envParams;
    const safeAttack = Math.max(0.001, attack); // Ensure non-zero time
    const safeDecay = Math.max(0.001, decay);

    targetParam.cancelScheduledValues(now); // Clear previous ramps

    if (isVcf) {
        // VCF Envelope Calculation
        const knobBaseFreq = params.filter.frequency.value; // Current cutoff knob value
        const envModAmount = params.vcfEnvGain.gain.value; // Env amount knob value
        // Key Following (adjust strength as needed)
        const keyFollowAmount = params.keyFollow > 0.5 ? (baseNote - 69) / 12 : 0; // Octaves from C4
        const keyFollowHz = keyFollowAmount * (knobBaseFreq * 0.2); // Adjust scaling factor
        // const keyFollowHz = keyFollowAmount * 220; // Alternative: fixed Hz per octave

        const baseFreqWithKeyFollow = Math.max(20, knobBaseFreq + keyFollowHz);

        // Calculate target values for envelope stages
        const attackPeakFreq = baseFreqWithKeyFollow + envModAmount;
        const sustainLevelFreq = baseFreqWithKeyFollow + (sustainValue * envModAmount); // sustainValue is VCF Env's sustain (0-1)

        // Clamp values to valid range
        const clampedBaseFreq = Math.min(audioContext.sampleRate / 2, Math.max(20, baseFreqWithKeyFollow));
        const clampedPeakFreq = Math.min(audioContext.sampleRate / 2, Math.max(20, attackPeakFreq));
        const clampedSustainFreq = Math.min(audioContext.sampleRate / 2, Math.max(20, sustainLevelFreq));

        // Schedule envelope ramps
        targetParam.setValueAtTime(clampedBaseFreq, now); // Start at base (or current value if mid-release?) - Let's start at base
        targetParam.linearRampToValueAtTime(clampedPeakFreq, now + safeAttack);
        targetParam.linearRampToValueAtTime(clampedSustainFreq, now + safeAttack + safeDecay);
        // console.log(`VCF Env: Base=${clampedBaseFreq.toFixed(1)}, Peak=${clampedPeakFreq.toFixed(1)}, Sustain=${clampedSustainFreq.toFixed(1)}`);

    } else {
        // VCA Envelope Calculation
        const peakVal = 1.0; // VCA attack always goes to full volume
        const sustainLevel = Math.max(0.0001, sustainValue); // sustainValue is VCA Env's sustain (0-1)

        // Schedule envelope ramps
        targetParam.setValueAtTime(0.0001, now); // Start silent
        targetParam.linearRampToValueAtTime(peakVal, now + safeAttack);
        targetParam.linearRampToValueAtTime(sustainLevel, now + safeAttack + safeDecay);
    }
}

// Trigger the Release stage
function releaseEnvelope(envParams, targetParam, now, isVcf = false, baseNote = 69) {
    if (!audioContext || !targetParam) return;
    const { release } = envParams;
    const safeRelease = Math.max(0.001, release);

    targetParam.cancelScheduledValues(now); // Important to prevent conflicts

    let releaseTargetValue;

    if (isVcf) {
        // VCF Release Target: Back to base frequency considering key follow
        const knobBaseFreq = params.filter.frequency.value;
        const keyFollowAmount = params.keyFollow > 0.5 ? (baseNote - 69) / 12 : 0;
        const keyFollowHz = keyFollowAmount * (knobBaseFreq * 0.2); // Use same scaling
        //const keyFollowHz = keyFollowAmount * 220;

        const baseFreqWithKeyFollow = Math.max(20, knobBaseFreq + keyFollowHz);
        releaseTargetValue = Math.min(audioContext.sampleRate / 2, Math.max(20, baseFreqWithKeyFollow));
         // console.log(`VCF Release: To=${releaseTargetValue.toFixed(1)}`);

    } else {
        // VCA Release Target: Silence
        releaseTargetValue = 0.0001; // Target near zero
    }

    // Schedule release ramp from current value
    targetParam.setValueAtTime(targetParam.value, now); // Hold current value
    targetParam.linearRampToValueAtTime(releaseTargetValue, now + safeRelease);

    // Optional: Schedule a stop after release for safety (though VCA going to 0 handles output)
    // if (!isVcf) {
    //    targetParam.setValueAtTime(0, now + safeRelease + 0.05); // Force to 0 shortly after release ends
    // }
}

// Helper to trigger both envelopes
function triggerEnvelopes(note, now) {
    if (!filter || !vcaGainNode) return;
    triggerEnvelope(params.vcfEnv, filter.frequency, params.vcfEnv.sustain, now, true, note);
    triggerEnvelope(params.vcaEnv, vcaGainNode.gain, params.vcaEnv.sustain, now, false);
}

// Helper to release both envelopes
function releaseEnvelopes(note, now) {
     if (!filter || !vcaGainNode) return;
     releaseEnvelope(params.vcfEnv, filter.frequency, now, true, note);
     releaseEnvelope(params.vcaEnv, vcaGainNode.gain, now, false);
}


// ----- MONOPHONIC NOTE HANDLING -----

function noteOn(note, freq) {
    if (!audioContext || audioContext.state !== 'running' || !vco1 || !vco2) {
        console.error("noteOn called but audio context not running or VCOs not ready!");
        return;
    }
    // console.log(`noteOn: Note=${note}, Freq=${freq.toFixed(2)}`);

    const now = audioContext.currentTime;
    const portamento = params.portamentoTime > 0.005 ? params.portamentoTime : 0;
    const shouldRetrigger = params.legato < 0.5; // Retrigger if legato is off

    const targetOsc1Freq = calculateVcoFrequency(freq, params.vco1);
    const targetOsc2Freq = calculateVcoFrequency(freq, params.vco2);

    if (currentNote !== null) {
        // --- Note Transition ---
        // console.log(`Transition from ${currentNote} to ${note}`);
        currentFrequency = freq; // Update base frequency
        currentNote = note; // Update current note *before* setting freq for legato release check

        if (portamento > 0) {
            // Glide to new frequency
            vco1.frequency.cancelScheduledValues(now); // Avoid conflicts if portamento was interrupted
            vco2.frequency.cancelScheduledValues(now);
            vco1.frequency.setTargetAtTime(targetOsc1Freq, now, portamento / 4); // Adjust glide curve steepness
            vco2.frequency.setTargetAtTime(targetOsc2Freq, now, portamento / 4);
        } else {
            // Jump to new frequency
            vco1.frequency.cancelScheduledValues(now);
            vco2.frequency.cancelScheduledValues(now);
            vco1.frequency.setValueAtTime(targetOsc1Freq, now);
            vco2.frequency.setValueAtTime(targetOsc2Freq, now);
        }

        // Retrigger envelopes only if legato is off
        if (shouldRetrigger) {
            // console.log("Retriggering envelopes (Legato Off)");
            triggerEnvelopes(note, now);
        } else {
            // Legato: Continue current envelope phase, just change pitch
             // console.log("Legato transition - no retrigger");
        }

    } else {
        // --- First Note ---
        // console.log(`First note: ${note}`);
        currentFrequency = freq;
        currentNote = note;

        // Set frequency instantly (no portamento from silence)
        vco1.frequency.cancelScheduledValues(now);
        vco2.frequency.cancelScheduledValues(now);
        vco1.frequency.setValueAtTime(targetOsc1Freq, now);
        vco2.frequency.setValueAtTime(targetOsc2Freq, now);

        // Always trigger envelopes for the first note
        triggerEnvelopes(note, now);
    }
}

function noteOff(note) {
    if (!isAudioInitialized || !isAudioResumed || currentNote === null || !vco1 || !vco2) {
        // Don't do anything if synth is off, no note is playing, or releasing a note not currently sounding
        return;
    }
    // console.log(`noteOff: Received for ${note}. Currently sounding: ${currentNote}`);

    // Find remaining physically held keys
    const remainingHeldCodes = Object.keys(pressedKeys).filter(code => pressedKeys[code] && keyToNoteMap[code]);

    if (note === currentNote) {
        // --- The sounding note was released ---
        if (remainingHeldCodes.length > 0) {
            // --- Transition to another held note (Last Note Priority) ---
            // Find the highest MIDI note among the remaining held keys
            let lastNote = -1;
            let lastNoteFreq = 0;
            remainingHeldCodes.forEach(code => {
                const heldNote = keyToNoteMap[code];
                if (heldNote > lastNote) { // Simple highest note priority
                    lastNote = heldNote;
                    lastNoteFreq = midiToFreq(lastNote);
                }
            });

            // console.log(`NoteOff ${note}: Transitioning to last held note: ${lastNote}`);
            const now = audioContext.currentTime;
            const portamento = params.portamentoTime > 0.005 ? params.portamentoTime : 0;

            const targetOsc1Freq = calculateVcoFrequency(lastNoteFreq, params.vco1);
            const targetOsc2Freq = calculateVcoFrequency(lastNoteFreq, params.vco2);

            currentFrequency = lastNoteFreq; // Update base frequency
            currentNote = lastNote; // Update current note

            if (portamento > 0) {
                vco1.frequency.cancelScheduledValues(now);
                vco2.frequency.cancelScheduledValues(now);
                vco1.frequency.setTargetAtTime(targetOsc1Freq, now, portamento / 4);
                vco2.frequency.setTargetAtTime(targetOsc2Freq, now, portamento / 4);
            } else {
                vco1.frequency.cancelScheduledValues(now);
                vco2.frequency.cancelScheduledValues(now);
                vco1.frequency.setValueAtTime(targetOsc1Freq, now);
                vco2.frequency.setValueAtTime(targetOsc2Freq, now);
            }
            // **Crucially, DO NOT retrigger envelopes here for legato behavior**

        } else {
            // --- Last key released ---
            // console.log(`NoteOff ${note}: Last key released. Triggering release.`);
            const now = audioContext.currentTime;
            releaseEnvelopes(currentNote, now); // Trigger release phase using the note that *was* playing
            currentNote = null; // Mark synth as silent
            currentFrequency = 0;
        }
    }
    // If the released note (note) was *not* the currently sounding note (currentNote),
    // we don't need to do anything, as the higher/later note still has priority.
    // The pressedKeys state is updated by the keyup handler regardless.
}


// ----- UI UPDATE FUNCTIONS -----
function updateKnobVisual(knob, value) {
    const min = parseFloat(knob.dataset.min);
    const max = parseFloat(knob.dataset.max);
    const steps = knob.dataset.steps ? knob.dataset.steps.split(',') : null;
    let percentage;
    const numericValue = parseFloat(value);

    knob.dataset.value = steps ? Math.round(numericValue).toString() : numericValue.toFixed(5);

    if (steps) {
        const stepIndex = Math.max(0, Math.min(steps.length - 1, Math.round(numericValue)));
        percentage = steps.length > 1 ? stepIndex / (steps.length - 1) : 0.5;

        // Update special indicators
        if (knob.id === 'vco1-waveshape') document.getElementById('vco1-shape-indicator').textContent = vcoShapeIndicators[stepIndex] || '?';
        if (knob.id === 'vco2-waveshape') document.getElementById('vco2-shape-indicator').textContent = vcoShapeIndicators[stepIndex] || '?';
        if (knob.id === 'lfo-waveshape') document.getElementById('lfo-shape-indicator').textContent = lfoShapeIndicators[stepIndex] || '?';
        if (knob.id === 'vco1-octave') document.getElementById('vco1-octave-indicator').textContent = octaveSteps[stepIndex] ? octaveSteps[stepIndex] + "'" : '?';
        if (knob.id === 'vco2-octave') document.getElementById('vco2-octave-indicator').textContent = octaveSteps[stepIndex] ? octaveSteps[stepIndex] + "'" : '?';

    } else { // Linear Knobs Visual
        const range = max - min;
        percentage = range !== 0 ? (numericValue - min) / range : 0.5;
    }

    percentage = Math.max(0, Math.min(1, percentage));
    const rotation = -135 + (percentage * 270);
    knob.style.transform = `rotate(${rotation}deg)`;
}

function updateSwitchVisual(sw) {
    const state = sw.dataset.state; // 'up' or 'down'
    const handle = sw.querySelector('.switch-handle');
    if (handle) handle.style.top = state === 'up' ? '2px' : '23px';

    const labelId = sw.id + '-label';
    const labelElement = document.getElementById(labelId);
    if (!labelElement) return;

    if (sw.dataset.values) { // Switch has specific text values (e.g., filter types)
        const values = sw.dataset.values.split(',');
        const text = state === 'up' ? values[0] : values[1];
        labelElement.textContent = text.toUpperCase();
    } else if (sw.dataset.param === 'legato') { // Specific handling for Legato switch label
         labelElement.textContent = state === 'up' ? 'LEGATO' : 'RETRIG';
    } else { // Default On/Off label
        labelElement.textContent = state === 'up' ? 'ON' : 'OFF';
    }
}

// Central function to update synth parameter based on UI interaction
function updateParameter(knobOrSwitch, newValue, forceUpdate = false) {
    const element = knobOrSwitch;
    const paramPath = element.dataset.param;
    const isKnob = element.classList.contains('knob');
    const isSwitch = element.classList.contains('switch');

    if (!paramPath || paramPath === 'dummy.xmod') return; // Ignore dummy controls

    let targetValue = newValue; // Value used for internal state/UI
    let actualAudioValue; // Value sent to Web Audio API

    // Determine targetValue and actualAudioValue based on control type
    if (isKnob) {
        const min = parseFloat(element.dataset.min);
        const max = parseFloat(element.dataset.max);
        const steps = element.dataset.steps ? element.dataset.steps.split(',') : null;
        const numericNewValue = parseFloat(newValue);

        if (steps) { // Stepped knob (like octave or waveshape)
            const stepIndex = Math.max(0, Math.min(steps.length - 1, Math.round(numericNewValue)));
            targetValue = stepIndex; // Store index internally
            const stepValueStr = steps[stepIndex];
            // Determine if the step value is numeric or string (e.g., waveform type)
            actualAudioValue = isNaN(parseFloat(stepValueStr)) ? stepValueStr : parseFloat(stepValueStr);
        } else { // Continuous knob
            targetValue = numericNewValue;
            targetValue = Math.max(min, Math.min(max, targetValue)); // Clamp
            actualAudioValue = targetValue;
        }
        updateKnobVisual(element, targetValue); // Update visual based on internal value

    } else if (isSwitch) {
        const state = newValue; // 'up' or 'down'
        element.dataset.state = state; // Store state

        if (element.dataset.values) { // Switch with defined values (e.g., 'lowpass', 'bandpass')
            const values = element.dataset.values.split(',');
            actualAudioValue = state === 'up' ? values[0] : values[1];
        } else { // Simple on/off switch treated as 1/0
            actualAudioValue = state === 'up' ? 1 : 0;
        }
        updateSwitchVisual(element); // Update visual based on state
        targetValue = actualAudioValue; // Store the derived audio value
        element.dataset.value = targetValue; // Store actual value in dataset for consistency
    }

    // --- Update Internal Params Object ---
    const parts = paramPath.split('.');
    let currentParamObj = params;
    try {
        for (let i = 0; i < parts.length - 1; i++) {
            if (!currentParamObj[parts[i]]) currentParamObj[parts[i]] = {}; // Create nested object if needed
            currentParamObj = currentParamObj[parts[i]];
        }
        const finalKey = parts[parts.length - 1];
        // Check if the final part is an object with a 'value' property (like gain nodes)
        if (typeof currentParamObj[finalKey] === 'object' && currentParamObj[finalKey] !== null && 'value' in currentParamObj[finalKey] && typeof actualAudioValue === 'number') {
            currentParamObj[finalKey].value = actualAudioValue;
        } else {
             // Otherwise, update the direct property (like type, octave, legato)
            currentParamObj[finalKey] = actualAudioValue;
        }
    } catch (e) { console.warn("Error updating internal params:", paramPath, e); }

    // --- Update Web Audio Node (only if initialized and resumed) ---
    if (isAudioInitialized && (isAudioResumed || forceUpdate) && audioContext) {
        const now = audioContext.currentTime;
        const rampTime = 0.010; // Short ramp for smooth transitions

        try {
            const valueToSet = actualAudioValue;

            // --- Direct Audio Param Updates ---
            if (paramPath === 'masterGain.gain.value' && masterGain) masterGain.gain.setTargetAtTime(valueToSet, now, rampTime);
            else if (paramPath === 'vco1Gain.gain.value' && vco1Gain) vco1Gain.gain.setTargetAtTime(valueToSet, now, rampTime);
            else if (paramPath === 'vco2Gain.gain.value' && vco2Gain) vco2Gain.gain.setTargetAtTime(valueToSet, now, rampTime);
            else if (paramPath === 'noiseGain.gain.value' && noiseGain) noiseGain.gain.setTargetAtTime(valueToSet, now, rampTime);
            else if (paramPath === 'vco1LfoGain.gain.value' && vco1LfoGain) vco1LfoGain.gain.setTargetAtTime(valueToSet, now, rampTime);
            else if (paramPath === 'vco2LfoGain.gain.value' && vco2LfoGain) vco2LfoGain.gain.setTargetAtTime(valueToSet, now, rampTime);
            else if (paramPath === 'vcfLfoGain.gain.value' && vcfLfoGain) vcfLfoGain.gain.setTargetAtTime(valueToSet, now, rampTime);
            else if (paramPath === 'vcaLfoGain.gain.value' && vcaLfoGain) vcaLfoGain.gain.setTargetAtTime(valueToSet, now, rampTime);
            else if (paramPath === 'vcfEnvGain.gain.value' && vcfEnvGain) vcfEnvGain.gain.setTargetAtTime(valueToSet, now, rampTime);
            else if (paramPath === 'reverbWetGain.gain.value' && reverbWetGain && reverbDryGain) {
                reverbWetGain.gain.setTargetAtTime(valueToSet, now, rampTime);
                reverbDryGain.gain.setTargetAtTime(1.0 - valueToSet, now, rampTime);
            }
            else if (paramPath === 'filter.frequency.value' && filter) filter.frequency.setTargetAtTime(valueToSet, now, rampTime);
            else if (paramPath === 'filter.Q.value' && filter) filter.Q.setTargetAtTime(valueToSet, now, rampTime);
            else if (paramPath === 'filter.type' && filter) filter.type = valueToSet;
            else if (paramPath === 'lfo.frequency.value' && lfo) lfo.frequency.setTargetAtTime(valueToSet, now, rampTime);
            else if (paramPath === 'lfo.type' && lfo) lfo.type = valueToSet;

            // --- Updates Affecting Persistent Oscillators ---
            else if (paramPath === 'vco1.type' && vco1) vco1.type = valueToSet;
            else if (paramPath === 'vco2.type' && vco2) vco2.type = valueToSet;
            else if (paramPath === 'vco1.octave' && vco1 && currentNote !== null) {
                const newFreq = calculateVcoFrequency(currentFrequency, params.vco1);
                vco1.frequency.setTargetAtTime(newFreq, now, rampTime * 2); // Slightly longer ramp for freq changes
            }
             else if (paramPath === 'vco2.octave' && vco2 && currentNote !== null) {
                const newFreq = calculateVcoFrequency(currentFrequency, params.vco2);
                vco2.frequency.setTargetAtTime(newFreq, now, rampTime * 2);
            }
            else if (paramPath === 'masterTune' || paramPath === 'vco2.detune.value') {
                if (vco1) vco1.detune.setTargetAtTime(params.masterTune, now, rampTime);
                if (vco2) vco2.detune.setTargetAtTime(params.masterTune + params.vco2.detune.value, now, rampTime);
            }
            // --- Envelope parameters (attack, decay, etc.) don't directly map to an audio param's value,
            //     they are used *when* trigger/release is called. No immediate audio node update needed. ---
            // --- keyFollow and portamentoTime are also used in calculations, no direct node update. ---
             // --- legato param also used in logic, no direct node update ---

        } catch (e) { console.error(`Error setting AudioNode param ${paramPath}:`, e, "Value:", valueToSet); }
    }
}

// Initialize knob visuals and parameters from data attributes
function updateAllKnobs(forceUpdate = false) {
    knobs.forEach(knob => {
        let value = knob.dataset.value || knob.getAttribute('data-default') || 0; // Use data-value or default
        let numericValue = parseFloat(value);
         // For stepped knobs, the initial value is the index
        if (knob.dataset.steps) numericValue = parseInt(value);
         updateParameter(knob, numericValue, forceUpdate);
    });
}

function updateAllSwitches(forceUpdate = false) {
    switches.forEach(sw => {
        const state = sw.dataset.state || sw.getAttribute('data-default-state') || 'down'; // Use data-state or default
        updateParameter(sw, state, forceUpdate);
    });
}


// ----- EVENT LISTENERS -----

// -- Keyboard Input --
let arrowKeyDown = null;
let shiftKeyDown = false;
let intervalId = null;

function handleKnobInteraction(knob, adjustmentFn) {
    const min = parseFloat(knob.dataset.min);
    const max = parseFloat(knob.dataset.max);
    const steps = knob.dataset.steps ? knob.dataset.steps.split(',') : null;
    let currentValue = parseFloat(knob.dataset.value); // Use the current internal value

    let newValue;

    if (steps) { // Stepped knob
        let currentStepIndex = Math.round(currentValue); // dataset.value stores the index
        newValue = adjustmentFn(currentStepIndex, 1); // Adjust index by 1
        newValue = Math.max(0, Math.min(steps.length - 1, newValue)); // Clamp index
    } else { // Linear knob
        let range = max - min; if (range <= 0) range = 1; // Avoid division by zero
        let stepAmount = range / 100; // Base step for linear knobs
        newValue = adjustmentFn(currentValue, stepAmount); // Adjust value by stepAmount
        newValue = Math.max(min, Math.min(max, newValue)); // Clamp value
    }

    // Only update if the value actually changed significantly
    if (Math.abs(newValue - currentValue) > 1e-9) { // Compare floats carefully
        updateParameter(knob, newValue);
    }
}

function handleArrowPress(knob, direction, isShift) {
    const multiplier = isShift ? 10 : 1; // Shift key makes adjustments larger
    handleKnobInteraction(knob, (current, step) => {
        const effectiveStep = step * multiplier;
        return direction === 'left' ? current - effectiveStep : current + effectiveStep;
    });
}

function startArrowRepeat(knob, direction, isShift) {
    stopArrowRepeat(); // Clear any existing interval
    handleArrowPress(knob, direction, isShift); // Fire once immediately
    // Set up repeating interval
    intervalId = setInterval(() => {
        if (!arrowKeyDown) { // Stop if key is released
             stopArrowRepeat();
             return;
        }
        handleArrowPress(knob, direction, isShift); // Fire repeatedly
    }, 75); // Repeat speed (milliseconds)
}

function stopArrowRepeat() {
    clearInterval(intervalId);
    intervalId = null;
}

// --- KEYDOWN LISTENER ---
document.addEventListener('keydown', async (e) => {
    // 1. Handle knob arrows first (doesn't require resumed context)
    if (document.activeElement && document.activeElement.classList.contains('knob')) {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            const direction = e.key === 'ArrowLeft' ? 'left' : 'right';
            const newShiftState = e.shiftKey;
            // Start/update repeat only if direction/shift changes or it's the first press
            if (arrowKeyDown !== direction || shiftKeyDown !== newShiftState || !intervalId) {
                arrowKeyDown = direction;
                shiftKeyDown = newShiftState;
                startArrowRepeat(document.activeElement, direction, shiftKeyDown);
            }
            return; // Don't process as note
        }
    }
     if (e.key === 'Shift') shiftKeyDown = true; // Track shift state

    // Ignore notes if modifiers held (allow Shift for arrows)
    if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
    }

    // 2. Check if it's a note key
    const note = keyToNoteMap[e.code];
    if (!note || pressedKeys[e.code] || e.repeat) {
        return; // Not a note key, or already pressed/repeating
    }

    // 3. Prevent default browser action for note keys (e.g., scrolling with S)
    e.preventDefault();

    // 4. Attempt to resume context IF it's not already marked as resumed
    let canPlay = isAudioResumed;
    if (!canPlay && isAudioInitialized) {
        // console.log(`Keydown for note ${note}. Attempting context resume...`);
        canPlay = await ensureAudioContextResumed();
    }

    // 5. If context is ready, process the note press
    if (canPlay) {
        pressedKeys[e.code] = true; // Mark key as down *before* calling noteOn
        const freq = midiToFreq(note);
        noteOn(note, freq);
    } else if (isAudioInitialized) {
        console.warn("Audio Context not running. Please click the synth panel or power button first.");
    } else {
        console.error("Audio not initialized. Cannot play note.");
    }
});
// --- END KEYDOWN LISTENER ---

// --- KEYUP LISTENER ---
document.addEventListener('keyup', (e) => {
    // Handle arrow key release for knobs
    if (document.activeElement && document.activeElement.classList.contains('knob')) {
        if ((e.key === 'ArrowLeft' && arrowKeyDown === 'left') || (e.key === 'ArrowRight' && arrowKeyDown === 'right')) {
            arrowKeyDown = null;
            stopArrowRepeat();
        }
    }
    // Handle Shift key release
    if (e.key === 'Shift') {
        shiftKeyDown = false;
        // If an arrow key is still held, restart the repeat timer with the non-shifted speed
        if (arrowKeyDown && intervalId && document.activeElement && document.activeElement.classList.contains('knob')) {
            startArrowRepeat(document.activeElement, arrowKeyDown, false);
        }
    }

    // Handle note release
    const note = keyToNoteMap[e.code];
    if (note && pressedKeys[e.code]) { // Check if this key was actually pressed according to our state
        pressedKeys[e.code] = false; // Mark key as up *before* calling noteOff
        noteOff(note);
    }
});
// --- END KEYUP LISTENER ---


// Release all notes on window blur
window.addEventListener('blur', () => {
    // console.log("Window blurred, releasing notes.");
    if (currentNote !== null) { // Only release if a note is sounding
        const now = audioContext ? audioContext.currentTime : 0;
        if (now > 0) { // Check if context is available
            releaseEnvelopes(currentNote, now);
        }
        currentNote = null; // Ensure synth state is silent
        currentFrequency = 0;
    }
    // Reset tracking states
    pressedKeys = {}; // Clear all held keys state
    arrowKeyDown = null;
    stopArrowRepeat();
    if (isDragging) stopDrag(); // Stop mouse drag if active
});

// -- Mouse Input for Knobs --
let isDragging = false;
let dragKnob = null;
let startY = 0;
let startValue = 0;

function handleKnobMouseMove(e) {
    if (!isDragging || !dragKnob) return;
    e.preventDefault(); // Prevent text selection during drag
    const currentY = e.clientY;
    const deltaY = startY - currentY; // Inverted Y-axis: dragging up increases value

    handleKnobInteraction(dragKnob, (current, step) => {
        const min = parseFloat(dragKnob.dataset.min);
        const max = parseFloat(dragKnob.dataset.max);
        const range = max - min;
        const sensitivityFactor = 1.0; // Adjust overall sensitivity
        const dragSensitivity = 1.8; // Fine-tune drag speed
        // Calculate change based on pixels moved
        const changePerPixel = (range > 0 ? range / 150 : 1 / 150) * dragSensitivity * sensitivityFactor; // Adjust 150 for more/less range per screen height
        let valueChange = deltaY * changePerPixel;
        let newValue = startValue + valueChange; // Calculate new value based on starting point

        // Round for stepped knobs *after* calculating the linear change
        if (dragKnob.dataset.steps) {
            newValue = Math.round(newValue);
        }
        return newValue; // Return the calculated new value (will be clamped in handleKnobInteraction)
    });
}

function stopDrag() {
    if (isDragging) {
        isDragging = false;
        dragKnob = null;
        document.body.classList.remove('dragging'); // Remove dragging cursor style
        // Remove listeners added on mousedown
        document.removeEventListener('mousemove', handleKnobMouseMove);
        document.removeEventListener('mouseup', stopDrag);
        document.removeEventListener('mouseleave', stopDrag); // Also stop if mouse leaves window
    }
}

knobs.forEach(knob => {
    knob.addEventListener('mousedown', (e) => {
        // Attempt resume on interaction, but don't block/await
        if (!isAudioResumed && isAudioInitialized) ensureAudioContextResumed();

        e.preventDefault();
        isDragging = true;
        dragKnob = knob;
        startY = e.clientY;
        startValue = parseFloat(knob.dataset.value); // Get starting value from dataset
        document.body.classList.add('dragging'); // Add dragging cursor style
        // Add global listeners to track mouse movement anywhere
        document.addEventListener('mousemove', handleKnobMouseMove);
        document.addEventListener('mouseup', stopDrag);
        document.addEventListener('mouseleave', stopDrag);
        knob.focus(); // Focus the knob for keyboard control
    });

    // Double-click to reset knob to default value
    knob.addEventListener('dblclick', (e) => {
        const defaultValueAttr = knob.getAttribute('data-default');
        if (defaultValueAttr !== null) {
            let defaultValue = parseFloat(defaultValueAttr);
             // For stepped knobs, the default value is the index
            if (knob.dataset.steps) defaultValue = parseInt(defaultValueAttr);
            updateParameter(knob, defaultValue);
        }
    });
});


// -- Switch Click/Key --
switches.forEach(sw => {
    const triggerSwitch = () => {
        // Attempt resume on interaction
        if (!isAudioResumed && isAudioInitialized) ensureAudioContextResumed();

        const currentState = sw.dataset.state;
        const newState = currentState === 'up' ? 'down' : 'up';
        updateParameter(sw, newState); // Update parameter with the new state ('up' or 'down')
    };

    sw.addEventListener('click', triggerSwitch);
    sw.addEventListener('keydown', (e) => { // Allow Enter/Space to toggle switches
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            triggerSwitch();
        }
    });
});

// -- General Interaction Listener for Audio Context --
// Acts as a fallback if other interactions fail to resume
synthPanel.addEventListener('click', () => {
    if (!isAudioResumed && isAudioInitialized) ensureAudioContextResumed();
}, { capture: true }); // Use capture to catch clicks on panel before knobs/switches maybe


// -- Power Button --
powerButton.addEventListener('click', async () => {
    if (!isAudioInitialized) {
        console.log("Power Button: Initializing Audio...");
        initAudio();
        updateAllKnobs(true); // Force update visuals and audio params after init
        updateAllSwitches(true);
        // InitAudio checks context state, so LED should be updated there
        // Optionally, try resuming immediately after init if state is suspended
        if (audioContext && audioContext.state === 'suspended') {
             await ensureAudioContextResumed();
        }
    } else {
        // If already initialized, just ensure it's resumed
        console.log("Power Button: Ensuring Audio Context is Resumed...");
        const resumed = await ensureAudioContextResumed();
        if(resumed) {
             if (!powerLed.classList.contains('on')) powerLed.classList.add('on');
        } else {
             if (powerLed.classList.contains('on')) powerLed.classList.remove('on');
              console.warn("Power Button: Could not resume audio context.");
        }
    }
});


// --- INITIAL SETUP ---
document.addEventListener('DOMContentLoaded', () => {
    // Initialize UI elements first based on defaults
    // Don't force audio update yet, wait for initAudio
    updateAllKnobs(false);
    updateAllSwitches(false);

    // Initialize waveform buttons
    document.querySelectorAll('.waveform-btn').forEach(button => {
        button.addEventListener('click', handleWaveformButtonClick);
    });

    // Attempt to initialize audio silently
    initAudio(); // This function handles the initial state check and LED

    console.log("Mono Synth Ready. Click panel/power button or press keys (A, W, S, E, D, F, T, G, Y, H, U, J, K) to start audio and play.");
    // Additional check after init in case it started suspended
    if (isAudioInitialized && audioContext?.state === 'suspended' && !powerLed.classList.contains('on')) {
        console.warn("REMINDER: Click the synth panel or press a key/power button to enable audio playback.");
    }
});

function handleSwitchChange(event) {
    const target = event.target;
    if (!target.classList.contains('waveform-btn')) return;

    const module = target.closest('.waveform-grid').dataset.module;
    const waveform = target.dataset.waveform;

    // Update active state
    const buttons = target.closest('.waveform-grid').querySelectorAll('.waveform-btn');
    buttons.forEach(btn => btn.classList.remove('active'));
    target.classList.add('active');

    // Update oscillator
    if (module === 'vco1') {
        params.vco1.type = waveform;
        updateVCO1Waveform();
    } else if (module === 'vco2') {
        params.vco2.type = waveform;
        updateVCO2Waveform();
    }
}

// Initialize Event Listeners
function initializeEventListeners() {
    knobs.forEach(knob => {
        knob.addEventListener('input', handleKnobChange);
    });

    switches.forEach(switch_ => {
        switch_.addEventListener('change', handleSwitchChange);
    });

    // Add event listeners for waveform buttons
    document.querySelectorAll('.waveform-btn').forEach(button => {
        button.addEventListener('click', handleWaveformButtonClick);
    });

    document.addEventListener('keydown', event => {
        if (event.repeat) return;
        const note = keyToNoteMap[event.key.toUpperCase()];
        if (note !== undefined) {
            const freq = midiToFreq(note);
            noteOn(note, freq);
        }
    });

    document.addEventListener('keyup', event => {
        const note = keyToNoteMap[event.key.toUpperCase()];
        if (note !== undefined) {
            noteOff(note);
        }
    });
}

// Handle waveform button clicks
function handleWaveformButtonClick(event) {
    const button = event.target;
    const module = button.closest('.waveform-grid').dataset.module;
    const waveform = button.dataset.waveform;

    // Update active state
    const buttons = button.closest('.waveform-grid').querySelectorAll('.waveform-btn');
    buttons.forEach(btn => btn.classList.remove('active'));
    button.classList.add('active');

    // Update oscillator
    if (module === 'vco1') {
        params.vco1.type = waveform;
        updateVCO1Waveform();
    } else if (module === 'vco2') {
        params.vco2.type = waveform;
        updateVCO2Waveform();
    }
}

function updateVCO1Waveform() {
    if (vco1) {
        vco1.type = params.vco1.type;
    }
}

function updateVCO2Waveform() {
    if (vco2) {
        vco2.type = params.vco2.type;
    }
}