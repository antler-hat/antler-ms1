// random-lfo-processor.js

class RandomLfoProcessor extends AudioWorkletProcessor {
    // Define custom parameters.
    static get parameterDescriptors() {
        return [{
            name: 'frequency',
            defaultValue: 5,
            minValue: 0.1,
            maxValue: 100,
            automationRate: 'k-rate' // Can change per block, but not per sample
        }];
    }

    constructor(options) {
        super(options);
        this.phase = 0;             // Current phase of the LFO cycle (0 to 1)
        this.currentValue = 0;      // The current random value being held
        this._updateInterval = 1;   // Calculated samples per LFO cycle
        this._lastFrequency = 5;    // Keep track of frequency for recalculation
        this._recalculateInterval(this._lastFrequency); // Initial calculation
    }

     // Helper to calculate how many samples are in one LFO cycle
    _recalculateInterval(frequency) {
        if (frequency > 0) {
            this._updateInterval = sampleRate / frequency; // sampleRate is global in AudioWorkletProcessor
        } else {
            this._updateInterval = Infinity; // Avoid division by zero, effectively stop updates
        }
         this._lastFrequency = frequency;
    }

    process(inputs, outputs, parameters) {
        const output = outputs[0]; // Get the first output channel array
        const frequencyParam = parameters.frequency; // Get frequency parameter array

        // Check if frequency changed (only need to check first value for k-rate)
        const currentFrequency = frequencyParam[0];
        if (currentFrequency !== this._lastFrequency) {
             this._recalculateInterval(currentFrequency);
        }

        const samplesPerCycle = this._updateInterval;

        // Process each sample in the block (typically 128 samples)
        for (let i = 0; i < output[0].length; ++i) {

            // Advance phase (normalized by samples per cycle)
            this.phase += 1.0;

            // If phase completes a cycle, generate new random value and reset phase
            if (this.phase >= samplesPerCycle) {
                this.phase -= samplesPerCycle; // Reset phase preserving remainder
                this.currentValue = Math.random() * 2 - 1; // New random value between -1 and 1
            }

            // Write the held value to all output channels
            for (let channel = 0; channel < output.length; ++channel) {
                output[channel][i] = this.currentValue;
            }
        }

        return true; // Keep processor alive
    }
}

registerProcessor('random-lfo-processor', RandomLfoProcessor);